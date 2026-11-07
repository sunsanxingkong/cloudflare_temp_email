import { Context } from 'hono';

import { CONSTANTS } from '../constants';
import { UserOauth2Settings } from "../models";
import { getJsonSetting, saveSetting } from '../utils';

async function getUserOauth2Settings(c: Context<HonoCustomType>): Promise<Response> {
    const settings = await getJsonSetting<UserOauth2Settings[]>(c, CONSTANTS.OAUTH2_SETTINGS_KEY);
    return c.json(settings || []);
}

async function saveUserOauth2Settings(c: Context<HonoCustomType>): Promise<Response> {
    const settings = await c.req.json<UserOauth2Settings[]>();
    const clientIDs = new Set<string>();
    for (const setting of settings) {
        setting.userIDKey = setting.userIDKey?.trim() || 'sub';
        setting.userEmailVerifiedKey = setting.userEmailVerifiedKey?.trim() || 'email_verified';
        setting.requireVerifiedEmail = setting.requireVerifiedEmail ?? false;
        setting.issuer = setting.issuer?.trim() || undefined;
        if (clientIDs.has(setting.clientID)) {
            return c.text(`Duplicate OAuth2 Client ID: ${setting.clientID}`, 400);
        }
        clientIDs.add(setting.clientID);
        if (!setting.name || !setting.clientID || !setting.clientSecret
            || !setting.authorizationURL || !setting.accessTokenURL
            || !setting.accessTokenFormat
            || !setting.userInfoURL || !setting.redirectURL
            || !setting.userEmailKey || !setting.userIDKey || !setting.scope) {
            return c.text(`${setting.name} is missing required fields`, 400);
        }
        if (setting.enableMailAllowList && (setting.mailAllowList?.length || 0) < 1) {
            return c.text(`${setting.name} is missing mail allow list`, 400);
        }
    }
    await saveSetting(c, CONSTANTS.OAUTH2_SETTINGS_KEY, JSON.stringify(settings));
    return c.json({ success: true })
}

export default {
    getUserOauth2Settings,
    saveUserOauth2Settings,
}
