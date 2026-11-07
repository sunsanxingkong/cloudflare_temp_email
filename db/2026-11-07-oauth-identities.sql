-- OAuth identities are keyed by provider namespace + client ID + stable subject.
-- Existing user rows and emails are intentionally not merged by this schema migration.
CREATE TABLE IF NOT EXISTS user_oauth_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    issuer TEXT NOT NULL,
    client_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_oauth_identity_subject
ON user_oauth_identities(issuer, client_id, subject);

CREATE INDEX IF NOT EXISTS idx_user_oauth_identity_user_id
ON user_oauth_identities(user_id);
