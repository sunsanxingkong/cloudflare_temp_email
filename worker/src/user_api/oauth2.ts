import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt';

import i18n from '../i18n';
import {
    getJsonSetting,
    getMailDomain,
    getStringValue,
    getUserRoles,
    includesDomain,
} from '../utils';
import { UserOauth2Settings } from '../models';
import { CONSTANTS } from '../constants';
import {
    getOAuthClaim,
    getOAuthIdentityIssuer,
    getOAuthSubject,
    isOAuthEmailVerified,
} from './oauth2_identity';

const LINK_STATE_PREFIX = 'oauth2-link-state:';
const LINK_STATE_TTL_SECONDS = 5 * 60;
const LEGACY_LINK_CONFIRM_PREFIX = 'oauth2-legacy-link-confirm:';

type UserRow = {
    id: number;
    user_email: string;
};

type OAuthLinkState = {
    user_id: number;
    clientID: string;
    issuer: string;
    userIDKey: string;
    redirectURL: string;
};

type OAuthLegacyLinkConfirmation = {
    user_id: number;
    clientID: string;
    issuer: string;
    subject: string;
    email: string;
    userIDKey: string;
    redirectURL: string;
};

class OAuthFlowError extends Error {
    status: 400 | 403 | 409 | 500 | 503;

    constructor(message: string, status: 400 | 403 | 409 | 500 | 503 = 400) {
        super(message);
        this.status = status;
    }
}

async function getSettings(c: Context<HonoCustomType>): Promise<UserOauth2Settings[]> {
    return await getJsonSetting<UserOauth2Settings[]>(c, CONSTANTS.OAUTH2_SETTINGS_KEY) || [];
}

function buildAuthorizationUrl(setting: UserOauth2Settings, state: string): string {
    const url = new URL(setting.authorizationURL);
    url.searchParams.set('client_id', setting.clientID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', setting.redirectURL);
    url.searchParams.set('scope', setting.scope);
    url.searchParams.set('state', state);
    return url.toString();
}

async function fetchOAuthUserInfo(
    setting: UserOauth2Settings,
    code: string,
    messages: ReturnType<typeof i18n.getMessagesbyContext>
): Promise<unknown> {
    const params = {
        code,
        client_id: setting.clientID,
        client_secret: setting.clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: setting.redirectURL,
    };
    const tokenResponse = await fetch(setting.accessTokenURL, {
        method: 'POST',
        body: setting.accessTokenFormat === 'json'
            ? JSON.stringify(params)
            : new URLSearchParams(params).toString(),
        headers: {
            'Content-Type': setting.accessTokenFormat === 'json'
                ? 'application/json'
                : 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
    });
    if (!tokenResponse.ok) {
        console.warn(`OAuth token endpoint returned ${tokenResponse.status}`);
        throw new OAuthFlowError(messages.Oauth2FailedGetAccessTokenMsg);
    }

    const token = await tokenResponse.json() as {
        access_token?: unknown;
        token_type?: unknown;
    };
    if (typeof token.access_token !== 'string' || !token.access_token) {
        throw new OAuthFlowError(messages.Oauth2FailedGetAccessTokenMsg);
    }

    const userResponse = await fetch(setting.userInfoURL, {
        headers: {
            Authorization: `${typeof token.token_type === 'string' ? token.token_type : 'Bearer'} ${token.access_token}`,
            Accept: 'application/json',
            'User-Agent': 'Cloudflare Workers',
        },
    });
    if (!userResponse.ok) {
        console.warn(`OAuth UserInfo endpoint returned ${userResponse.status}`);
        throw new OAuthFlowError(messages.Oauth2FailedGetUserInfoMsg);
    }

    const userInfo = await userResponse.json() as unknown;
    if (!userInfo || typeof userInfo !== 'object') {
        throw new OAuthFlowError(messages.Oauth2FailedGetUserInfoMsg);
    }
    return userInfo;
}

function transformOAuthEmail(rawEmail: unknown, setting: UserOauth2Settings): string | null {
    if (rawEmail === undefined || rawEmail === null || rawEmail === '') return null;
    const rawEmailString = String(rawEmail).slice(0, 256).trim();
    if (!rawEmailString) return null;
    if (!setting.enableEmailFormat || !setting.userEmailFormat) return rawEmailString;

    try {
        const regex = new RegExp(setting.userEmailFormat);
        return rawEmailString.replace(regex, setting.userEmailReplace || '$1').trim() || null;
    } catch {
        console.warn('Invalid OAuth userEmailFormat regex');
        return rawEmailString;
    }
}

async function getUserByOAuthIdentity(
    c: Context<HonoCustomType>,
    issuer: string,
    clientID: string,
    subject: string,
): Promise<UserRow | null> {
    return await c.env.DB.prepare(
        `SELECT users.id, users.user_email FROM user_oauth_identities`
        + ` JOIN users ON users.id = user_oauth_identities.user_id`
        + ` WHERE user_oauth_identities.issuer = ?`
        + ` AND user_oauth_identities.client_id = ?`
        + ` AND user_oauth_identities.subject = ?`
    ).bind(issuer, clientID, subject).first<UserRow>();
}

async function createUserTokenResponse(
    c: Context<HonoCustomType>,
    user: UserRow,
    messages: ReturnType<typeof i18n.getMessagesbyContext>,
): Promise<Response> {
    const defaultRole = getStringValue(c.env.USER_DEFAULT_ROLE);
    if (defaultRole) {
        const userRoles = getUserRoles(c);
        if (!userRoles.find((role) => role.role === defaultRole)) {
            return c.text(messages.InvalidUserDefaultRoleMsg, 500);
        }
        const roleResult = await c.env.DB.prepare(
            `INSERT INTO user_roles (user_id, role_text) VALUES (?, ?)`
            + ` ON CONFLICT(user_id) DO NOTHING`
        ).bind(user.id, defaultRole).run();
        if (!roleResult.success) {
            return c.text(messages.FailedUpdateUserDefaultRoleMsg, 500);
        }
    }

    const jwt = await Jwt.sign({
        user_email: user.user_email,
        user_id: user.id,
        exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        iat: Math.floor(Date.now() / 1000),
    }, c.env.JWT_SECRET, 'HS256');
    return c.json({ jwt });
}

function applyMailAllowList(
    c: Context<HonoCustomType>,
    email: string,
    setting: UserOauth2Settings,
    messages: ReturnType<typeof i18n.getMessagesbyContext>,
): Response | null {
    const mailDomain = getMailDomain(email);
    if (setting.enableMailAllowList && !includesDomain(setting.mailAllowList, mailDomain)) {
        return c.text(`${messages.UserMailDomainMustInMsg} ${JSON.stringify(setting.mailAllowList || [])}`, 400);
    }
    return null;
}

function generateSecureState(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function maskEmail(email: string): string {
    const atIndex = email.indexOf('@');
    if (atIndex <= 0) return '***';
    return `${email.slice(0, 1)}***${email.slice(atIndex)}`;
}

export default {
    getOauth2LoginUrl: async (c: Context<HonoCustomType>) => {
        const settings = await getSettings(c);
        const { clientID, state } = c.req.query();
        const messages = i18n.getMessagesbyContext(c);
        const setting = settings.find((candidate) => candidate.clientID === clientID);
        if (!setting) return c.text(messages.Oauth2ClientIDNotFoundMsg, 400);
        if (!state) return c.text(messages.Oauth2CliendIDOrCodeMissingMsg, 400);

        try {
            return c.json({ url: buildAuthorizationUrl(setting, state) });
        } catch {
            return c.text(messages.Oauth2ClientIDNotFoundMsg, 400);
        }
    },

    oauth2Login: async (c: Context<HonoCustomType>) => {
        const messages = i18n.getMessagesbyContext(c);
        try {
            const { clientID, code } = await c.req.json<{ clientID?: string; code?: string }>();
            if (!clientID || !code) {
                return c.text(messages.Oauth2CliendIDOrCodeMissingMsg, 400);
            }
            const setting = (await getSettings(c)).find((candidate) => candidate.clientID === clientID);
            if (!setting) return c.text(messages.Oauth2ClientIDNotFoundMsg, 400);

            const userInfo = await fetchOAuthUserInfo(setting, code, messages);
            const subject = await getOAuthSubject(userInfo, setting);
            if (!subject) return c.text(messages.Oauth2FailedGetUserSubMsg, 400);

            const issuer = getOAuthIdentityIssuer(setting);
            const mappedUser = await getUserByOAuthIdentity(c, issuer, clientID, subject);
            if (mappedUser) {
                if (setting.enableMailAllowList) {
                    const providerEmail = transformOAuthEmail(
                        await getOAuthClaim(userInfo, setting.userEmailKey),
                        setting,
                    );
                    if (!providerEmail) return c.text(messages.Oauth2FailedGetUserEmailMsg, 400);
                    const allowListResponse = applyMailAllowList(c, providerEmail, setting, messages);
                    if (allowListResponse) return allowListResponse;
                }
                return await createUserTokenResponse(c, mappedUser, messages);
            }

            const rawEmail = await getOAuthClaim(userInfo, setting.userEmailKey);
            const email = transformOAuthEmail(rawEmail, setting);
            if (!email) return c.text(messages.Oauth2FailedGetUserEmailMsg, 400);
            if (setting.requireVerifiedEmail && !await isOAuthEmailVerified(userInfo, setting)) {
                return c.text(messages.Oauth2EmailNotVerifiedMsg, 403);
            }
            const allowListResponse = applyMailAllowList(c, email, setting, messages);
            if (allowListResponse) return allowListResponse;

            const existingEmail = await c.env.DB.prepare(
                `SELECT id FROM users WHERE user_email = ?`
            ).bind(email).first<{ id: number }>();
            if (existingEmail) {
                const rawEmailString = typeof rawEmail === 'string' ? rawEmail.trim() : '';
                const verifiedDirectEmail = !setting.enableEmailFormat
                    && rawEmailString === email
                    && rawEmailString.includes('@')
                    && await isOAuthEmailVerified(userInfo, setting);
                if (verifiedDirectEmail && c.env.KV) {
                    const pendingToken = generateSecureState();
                    const pendingLink: OAuthLegacyLinkConfirmation = {
                        user_id: existingEmail.id,
                        clientID,
                        issuer,
                        subject,
                        email,
                        userIDKey: setting.userIDKey?.trim() || 'sub',
                        redirectURL: setting.redirectURL,
                    };
                    await c.env.KV.put(
                        `${LEGACY_LINK_CONFIRM_PREFIX}${pendingToken}`,
                        JSON.stringify(pendingLink),
                        { expirationTtl: LINK_STATE_TTL_SECONDS },
                    );
                    return c.json({
                        linkRequired: true,
                        pendingToken,
                        maskedEmail: maskEmail(email),
                        providerName: setting.name,
                    });
                }
                return c.text(messages.Oauth2ExistingEmailNeedsLinkMsg, 409);
            }

            // D1 batch is transactional. If either the user or subject collides,
            // neither insert is committed; this prevents orphan users and races.
            await c.env.DB.batch([
                c.env.DB.prepare(
                    `INSERT INTO users (user_email, password, user_info) VALUES (?, '', ?)`
                ).bind(email, JSON.stringify(userInfo)),
                c.env.DB.prepare(
                    `INSERT INTO user_oauth_identities (user_id, issuer, client_id, subject)`
                    + ` VALUES (last_insert_rowid(), ?, ?, ?)`
                ).bind(issuer, clientID, subject),
            ]);

            const createdUser = await getUserByOAuthIdentity(c, issuer, clientID, subject);
            if (!createdUser) {
                const raceWinner = await getUserByOAuthIdentity(c, issuer, clientID, subject);
                if (raceWinner) return await createUserTokenResponse(c, raceWinner, messages);
                const emailNowExists = await c.env.DB.prepare(
                    `SELECT id FROM users WHERE user_email = ?`
                ).bind(email).first<{ id: number }>();
                if (emailNowExists) {
                    return c.text(messages.Oauth2ExistingEmailNeedsLinkMsg, 409);
                }
                return c.text(messages.FailedToRegisterMsg, 500);
            }
            return await createUserTokenResponse(c, createdUser, messages);
        } catch (error) {
            if (error instanceof OAuthFlowError) {
                return c.text(error.message, error.status);
            }
            console.error('OAuth login failed', error);
            return c.text(messages.FailedToRegisterMsg, 500);
        }
    },

    getOAuthIdentities: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get('userPayload');
        const settings = await getSettings(c);
        const identities = await c.env.DB.prepare(
            `SELECT issuer, client_id, created_at FROM user_oauth_identities`
            + ` WHERE user_id = ? ORDER BY created_at`
        ).bind(user_id).all<{ issuer: string; client_id: string; created_at: string }>();

        return c.json({
            providers: settings.map((setting) => ({
                clientID: setting.clientID,
                name: setting.name,
                icon: setting.icon,
                issuer: getOAuthIdentityIssuer(setting),
            })),
            identities: identities.results || [],
        });
    },

    startOAuth2Link: async (c: Context<HonoCustomType>) => {
        const messages = i18n.getMessagesbyContext(c);
        if (!c.env.KV) return c.text(messages.KVNotAvailableMsg, 503);
        const { clientID } = await c.req.json<{ clientID?: string }>();
        const setting = (await getSettings(c)).find((candidate) => candidate.clientID === clientID);
        if (!clientID || !setting) return c.text(messages.Oauth2ClientIDNotFoundMsg, 400);

        const user = c.get('userPayload');
        const issuer = getOAuthIdentityIssuer(setting);
        const state = generateSecureState();
        const linkState: OAuthLinkState = {
            user_id: user.user_id,
            clientID,
            issuer,
            userIDKey: setting.userIDKey?.trim() || 'sub',
            redirectURL: setting.redirectURL,
        };
        await c.env.KV.put(
            `${LINK_STATE_PREFIX}${state}`,
            JSON.stringify(linkState),
            { expirationTtl: LINK_STATE_TTL_SECONDS },
        );

        try {
            return c.json({ state, url: buildAuthorizationUrl(setting, state) });
        } catch {
            await c.env.KV.delete(`${LINK_STATE_PREFIX}${state}`);
            return c.text(messages.Oauth2ClientIDNotFoundMsg, 400);
        }
    },

    completeOAuth2Link: async (c: Context<HonoCustomType>) => {
        const messages = i18n.getMessagesbyContext(c);
        if (!c.env.KV) return c.text(messages.KVNotAvailableMsg, 503);
        const { clientID, code, state } = await c.req.json<{
            clientID?: string;
            code?: string;
            state?: string;
        }>();
        if (!clientID || !code || !state) {
            return c.text(messages.Oauth2CliendIDOrCodeMissingMsg, 400);
        }

        const stateKey = `${LINK_STATE_PREFIX}${state}`;
        const stateValue = await c.env.KV.get(stateKey);
        if (!stateValue) return c.text(messages.Oauth2LinkStateInvalidMsg, 400);
        await c.env.KV.delete(stateKey);

        let linkState: OAuthLinkState;
        try {
            linkState = JSON.parse(stateValue) as OAuthLinkState;
        } catch {
            return c.text(messages.Oauth2LinkStateInvalidMsg, 400);
        }

        const user = c.get('userPayload');
        if (linkState.user_id !== user.user_id || linkState.clientID !== clientID) {
            return c.text(messages.Oauth2LinkStateInvalidMsg, 400);
        }
        const setting = (await getSettings(c)).find((candidate) => candidate.clientID === clientID);
        if (!setting
            || getOAuthIdentityIssuer(setting) !== linkState.issuer
            || (setting.userIDKey?.trim() || 'sub') !== linkState.userIDKey
            || setting.redirectURL !== linkState.redirectURL) {
            return c.text(messages.Oauth2LinkStateInvalidMsg, 400);
        }

        try {
            const userInfo = await fetchOAuthUserInfo(setting, code, messages);
            const subject = await getOAuthSubject(userInfo, setting);
            if (!subject) return c.text(messages.Oauth2FailedGetUserSubMsg, 400);

            const existingIdentity = await c.env.DB.prepare(
                `SELECT user_id FROM user_oauth_identities`
                + ` WHERE issuer = ? AND client_id = ? AND subject = ?`
            ).bind(linkState.issuer, clientID, subject).first<{ user_id: number }>();
            if (existingIdentity) {
                if (existingIdentity.user_id === user.user_id) {
                    return c.json({ success: true, alreadyLinked: true });
                }
                return c.text(messages.Oauth2IdentityAlreadyLinkedMsg, 409);
            }

            const account = await c.env.DB.prepare(
                `SELECT id FROM users WHERE id = ?`
            ).bind(user.user_id).first<{ id: number }>();
            if (!account) return c.text(messages.UserNotFoundMsg, 400);

            try {
                await c.env.DB.prepare(
                    `INSERT INTO user_oauth_identities (user_id, issuer, client_id, subject)`
                    + ` VALUES (?, ?, ?, ?)`
                ).bind(user.user_id, linkState.issuer, clientID, subject).run();
            } catch {
                const raceWinner = await c.env.DB.prepare(
                    `SELECT user_id FROM user_oauth_identities`
                    + ` WHERE issuer = ? AND client_id = ? AND subject = ?`
                ).bind(linkState.issuer, clientID, subject).first<{ user_id: number }>();
                if (raceWinner?.user_id === user.user_id) {
                    return c.json({ success: true, alreadyLinked: true });
                }
                return c.text(messages.Oauth2IdentityAlreadyLinkedMsg, 409);
            }

            return c.json({ success: true, alreadyLinked: false });
        } catch (error) {
            if (error instanceof OAuthFlowError) {
                return c.text(error.message, error.status);
            }
            console.error('OAuth identity link failed', error);
            return c.text(messages.Oauth2FailedGetUserInfoMsg, 400);
        }
    },

    confirmOAuth2LegacyLink: async (c: Context<HonoCustomType>) => {
        const messages = i18n.getMessagesbyContext(c);
        if (!c.env.KV) return c.text(messages.KVNotAvailableMsg, 503);
        const { pendingToken } = await c.req.json<{ pendingToken?: string }>();
        if (!pendingToken) return c.text(messages.Oauth2LinkStateInvalidMsg, 400);

        const pendingKey = `${LEGACY_LINK_CONFIRM_PREFIX}${pendingToken}`;
        const pendingValue = await c.env.KV.get(pendingKey);
        if (!pendingValue) return c.text(messages.Oauth2LinkStateInvalidMsg, 400);
        await c.env.KV.delete(pendingKey);

        let pendingLink: OAuthLegacyLinkConfirmation;
        try {
            pendingLink = JSON.parse(pendingValue) as OAuthLegacyLinkConfirmation;
        } catch {
            return c.text(messages.Oauth2LinkStateInvalidMsg, 400);
        }

        const setting = (await getSettings(c)).find((candidate) => candidate.clientID === pendingLink.clientID);
        if (!setting
            || getOAuthIdentityIssuer(setting) !== pendingLink.issuer
            || (setting.userIDKey?.trim() || 'sub') !== pendingLink.userIDKey
            || setting.redirectURL !== pendingLink.redirectURL) {
            return c.text(messages.Oauth2LinkStateInvalidMsg, 400);
        }

        try {
            const account = await c.env.DB.prepare(
                `SELECT id, user_email FROM users WHERE id = ?`
            ).bind(pendingLink.user_id).first<UserRow>();
            if (!account || account.user_email !== pendingLink.email) {
                return c.text(messages.Oauth2LinkStateInvalidMsg, 400);
            }

            const existingIdentity = await c.env.DB.prepare(
                `SELECT user_id FROM user_oauth_identities`
                + ` WHERE issuer = ? AND client_id = ? AND subject = ?`
            ).bind(pendingLink.issuer, pendingLink.clientID, pendingLink.subject).first<{ user_id: number }>();
            if (existingIdentity && existingIdentity.user_id !== pendingLink.user_id) {
                return c.text(messages.Oauth2IdentityAlreadyLinkedMsg, 409);
            }

            if (!existingIdentity) {
                try {
                    await c.env.DB.prepare(
                        `INSERT INTO user_oauth_identities (user_id, issuer, client_id, subject)`
                        + ` VALUES (?, ?, ?, ?)`
                    ).bind(
                        pendingLink.user_id,
                        pendingLink.issuer,
                        pendingLink.clientID,
                        pendingLink.subject,
                    ).run();
                } catch {
                    const raceWinner = await c.env.DB.prepare(
                        `SELECT user_id FROM user_oauth_identities`
                        + ` WHERE issuer = ? AND client_id = ? AND subject = ?`
                    ).bind(pendingLink.issuer, pendingLink.clientID, pendingLink.subject)
                        .first<{ user_id: number }>();
                    if (raceWinner?.user_id !== pendingLink.user_id) {
                        return c.text(messages.Oauth2IdentityAlreadyLinkedMsg, 409);
                    }
                }
            }

            return await createUserTokenResponse(c, account, messages);
        } catch (error) {
            console.error('OAuth legacy identity confirmation failed', error);
            return c.text(messages.FailedToRegisterMsg, 500);
        }
    },
};
