
CREATE DATABASE IF NOT EXISTS uno_online
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE uno_online;

CREATE TABLE IF NOT EXISTS users (
  id             CHAR(36)     NOT NULL,
  username       VARCHAR(32)  NOT NULL,
  password_salt  CHAR(32)     NOT NULL,
  password_hash  CHAR(128)    NOT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at  DATETIME         NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  CHAR(64)  NOT NULL,
  user_id     CHAR(36)  NOT NULL,
  created_at  DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME  NOT NULL,
  user_agent  VARCHAR(255) NULL,
  PRIMARY KEY (token_hash),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rooms (
  id           CHAR(36)     NOT NULL,
  name         VARCHAR(64)  NOT NULL,
  owner_id     CHAR(36)     NOT NULL,
  status       ENUM('open', 'playing', 'closed') NOT NULL DEFAULT 'open',
  max_players  TINYINT      NOT NULL DEFAULT 4,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at    DATETIME         NULL,
  PRIMARY KEY (id),
  KEY idx_rooms_status (status),
  CONSTRAINT fk_rooms_owner FOREIGN KEY (owner_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS room_players (
  room_id    CHAR(36) NOT NULL,
  user_id    CHAR(36) NOT NULL,
  seat       TINYINT  NOT NULL,
  joined_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at    DATETIME     NULL,
  PRIMARY KEY (room_id, user_id),
  UNIQUE KEY uq_room_seat (room_id, seat),
  CONSTRAINT fk_rp_room FOREIGN KEY (room_id)
    REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT fk_rp_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS games (
  id           CHAR(36) NOT NULL,
  room_id      CHAR(36) NOT NULL,
  status       ENUM('playing', 'finished', 'aborted') NOT NULL DEFAULT 'playing',
  version      INT      NOT NULL DEFAULT 1,
  state        JSON     NOT NULL,
  winner_id    CHAR(36)     NULL,
  started_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at  DATETIME     NULL,
  PRIMARY KEY (id),
  KEY idx_games_room (room_id),
  KEY idx_games_status (status),
  CONSTRAINT fk_games_room FOREIGN KEY (room_id)
    REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT fk_games_winner FOREIGN KEY (winner_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;
