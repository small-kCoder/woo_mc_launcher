CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  version_id TEXT NOT NULL,
  network_name TEXT NOT NULL,
  network_secret TEXT NOT NULL,
  host_virtual_ip TEXT NOT NULL,
  host_lan_ip TEXT NOT NULL,
  game_port INTEGER NOT NULL,
  host_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rooms_expires ON rooms (expires_at);
