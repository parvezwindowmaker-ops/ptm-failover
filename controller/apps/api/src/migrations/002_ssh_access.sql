CREATE TABLE ssh_connections (
  originId TEXT PRIMARY KEY REFERENCES origins(id) ON DELETE CASCADE,
  config TEXT NOT NULL,
  encryptedSecret TEXT NOT NULL,
  passphraseConfigured INTEGER NOT NULL DEFAULT 0,
  lastTested INTEGER,
  validationState TEXT NOT NULL DEFAULT 'Unknown'
    CHECK(validationState IN ('Unknown','Valid','Failed'))
);
