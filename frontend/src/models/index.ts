export type UserOauth2Settings = {
    name: string;
    icon?: string;                // SVG icon string for the provider
    clientID: string;
    clientSecret: string;
    authorizationURL: string;
    accessTokenURL: string;
    accessTokenFormat?: string;
    userInfoURL: string;
    issuer?: string;
    redirectURL: string;
    logoutURL?: string;
    userEmailKey: string;
    userIDKey?: string;
    userEmailVerifiedKey?: string;
    requireVerifiedEmail?: boolean;
    enableEmailFormat?: boolean;  // Enable email format transformation
    userEmailFormat?: string;     // Regex pattern to match email
    userEmailReplace?: string;    // Replacement template using $1, $2, etc.
    scope: string;
    enableMailAllowList?: boolean | undefined;
    mailAllowList?: string[] | undefined;
}
