import { UserOauth2Settings } from '../models';

/**
 * A subject is only stable within its provider/client namespace. Prefer an
 * explicitly configured OIDC issuer; otherwise derive the namespace from the
 * configured UserInfo endpoint origin.
 */
export function getOAuthIdentityIssuer(setting: UserOauth2Settings): string {
    const configuredIssuer = setting.issuer?.trim();
    if (configuredIssuer) {
        try {
            const url = new URL(configuredIssuer);
            url.search = '';
            url.hash = '';
            return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
        } catch {
            return configuredIssuer.replace(/\/+$/, '');
        }
    }

    try {
        return new URL(setting.userInfoURL).origin;
    } catch {
        return setting.userInfoURL.trim().replace(/\/+$/, '');
    }
}

export async function getOAuthClaim(
    userInfo: unknown,
    key: string | undefined
): Promise<unknown> {
    if (!key?.trim() || !userInfo || typeof userInfo !== 'object') return undefined;

    const claimKey = key.trim();
    if (claimKey.startsWith('$')) {
        try {
            const { JSONPath } = await import('jsonpath-plus');
            const values = JSONPath({ path: claimKey, json: userInfo });
            return Array.isArray(values) ? values[0] : values;
        } catch {
            return undefined;
        }
    }

    return (userInfo as Record<string, unknown>)[claimKey];
}

/**
 * OIDC uses `sub`. Legacy non-OIDC providers may omit the new configuration
 * field; for those only, an explicit provider `id` claim is accepted as the
 * stable subject. Email and username are never used as identity fallbacks.
 */
export async function getOAuthSubject(
    userInfo: unknown,
    setting: UserOauth2Settings
): Promise<string | null> {
    const configuredKey = setting.userIDKey?.trim();
    let value = await getOAuthClaim(userInfo, configuredKey || 'sub');

    if (value === undefined || value === null || value === '') {
        if (configuredKey) return null;
        value = await getOAuthClaim(userInfo, 'id');
    }

    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const subject = String(value).trim();
    if (!subject || subject.length > 512) return null;
    return subject;
}

export async function isOAuthEmailVerified(
    userInfo: unknown,
    setting: UserOauth2Settings
): Promise<boolean> {
    const value = await getOAuthClaim(
        userInfo,
        setting.userEmailVerifiedKey?.trim() || 'email_verified'
    );
    return value === true || value === 1 || value === '1'
        || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}
