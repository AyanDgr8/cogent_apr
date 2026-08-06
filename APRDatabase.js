// APRDatabase.js
// Run this script to create / update the AGENT_REPORTS database and all tenant tables.
// Tables are generated dynamically from TENANT_CONFIG in tenantConfig.js.
//
// Usage:
//   node APRDatabase.js
//
// To add a new tenant:
//   1. Add the tenant entry to TENANT_CONFIG in tenantConfig.js
//   2. Re-run: node APRDatabase.js

import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';
import { TENANT_CONFIG } from './tenantConfig.js';

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'Ayan@1012',
  port: parseInt(process.env.DB_PORT) || 3306,
  timezone: '+05:30',
  multipleStatements: true
};

const DB_NAME = process.env.DB_NAME || 'AGENT_REPORT_COGENT';

// ─── DDL builders for APR tables ───────────────────────────────────────────

function createAgentStatsTable(suffix) {
  return `
CREATE TABLE IF NOT EXISTS agent_stats_${suffix} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agent_name VARCHAR(255) NOT NULL,
    agent_extension VARCHAR(10),
    agent_tags JSON,
    raw_data JSON NOT NULL,
    start_time INT NOT NULL COMMENT 'Unix timestamp for slot start time',
    end_time INT NOT NULL COMMENT 'Unix timestamp for slot end time',
    time_slot_label VARCHAR(100) NOT NULL COMMENT 'Human readable time slot',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_agent_name (agent_name),
    INDEX idx_start_time (start_time),
    INDEX idx_end_time (end_time),
    INDEX idx_time_slot (start_time, end_time),
    INDEX idx_created_at (created_at),
    UNIQUE KEY unique_agent_time_slot (agent_extension, start_time, end_time)
);`;
}

function createAgentActivityTable(suffix) {
  return `
CREATE TABLE IF NOT EXISTS agent_activity_${suffix} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agent_name VARCHAR(255) NOT NULL,
    event_timestamp INT NOT NULL COMMENT 'Unix timestamp of the event',
    raw_data JSON NOT NULL,
    time_slot_start INT NOT NULL COMMENT 'Start time of the hourly slot',
    time_slot_end INT NOT NULL COMMENT 'End time of the hourly slot',
    time_slot_label VARCHAR(100) NOT NULL COMMENT 'Human readable time slot',
    event_type VARCHAR(50) COMMENT 'Type of event',
    event_state VARCHAR(50) COMMENT 'Agent state',
    custom_states TEXT COMMENT 'Format: [state_name : timestamp], ...',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_agent_name (agent_name),
    INDEX idx_event_timestamp (event_timestamp),
    INDEX idx_time_slot (time_slot_start, time_slot_end),
    INDEX idx_event_type (event_type),
    INDEX idx_event_state (event_state),
    INDEX idx_created_at (created_at),
    INDEX idx_agent_time (agent_name, event_timestamp),
    INDEX idx_agent_slot (agent_name, time_slot_start, time_slot_end),
    INDEX idx_slot_state (time_slot_start, time_slot_end, event_state),
    UNIQUE KEY unique_agent_activity (agent_name, event_timestamp)
);`;
}

function createAgentCompleteHourlyTable(suffix, tenantKey) {
  // Get tenant config to extract custom states dynamically
  const tenantConfig = TENANT_CONFIG[tenantKey];
  const allStates = [
    ...(tenantConfig?.productive_states || []),
    ...(tenantConfig?.non_productive_states || [])
  ];
  
  // Generate custom state columns dynamically
  const customStateColumns = allStates.map(state => {
    const columnName = `custom_state_${state.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    return `    ${columnName} VARCHAR(20) DEFAULT '00:00:00'`;
  }).join(',\n');
  
  return `
CREATE TABLE IF NOT EXISTS agent_complete_hourly_${suffix} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agent_name VARCHAR(255) NOT NULL,
    agent_extension VARCHAR(10) NOT NULL,
    start_time INT NOT NULL COMMENT 'Unix timestamp for slot start time',
    end_time INT NOT NULL COMMENT 'Unix timestamp for slot end time',
    time_slot_label VARCHAR(100) NOT NULL COMMENT 'Human readable time slot',
    slot_start_datetime DATETIME COMMENT 'Readable start datetime',
    slot_end_datetime DATETIME COMMENT 'Readable end datetime',
    total_calls INT DEFAULT 0,
    answered_calls INT DEFAULT 0,
    failed_calls INT DEFAULT 0,
    answer_rate_percent DECIMAL(5,2) DEFAULT 0.00,
    aht VARCHAR(20) DEFAULT '00:00:00',
    login_time VARCHAR(20) DEFAULT '00:00:00',
    first_login_time VARCHAR(50),
    last_logout_time VARCHAR(50),
    not_available_time VARCHAR(20) DEFAULT '00:00:00',
    wrap_up_time VARCHAR(20) DEFAULT '00:00:00',
    hold_time VARCHAR(20) DEFAULT '00:00:00',
    on_call_time VARCHAR(20) DEFAULT '00:00:00',
    custom_states TEXT COMMENT 'Format: [state_name : timestamp], ...',
${customStateColumns},
    productive_break_time VARCHAR(20) DEFAULT '00:00:00',
    non_productive_break_time VARCHAR(20) DEFAULT '00:00:00',
    idle_time VARCHAR(20) DEFAULT '00:00:00',
    report_start_time INT NOT NULL,
    report_end_time INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_agent_extension (agent_extension),
    INDEX idx_agent_name (agent_name),
    INDEX idx_start_time (start_time),
    INDEX idx_end_time (end_time),
    INDEX idx_time_slot (start_time, end_time),
    INDEX idx_report_time (report_start_time, report_end_time),
    INDEX idx_created_at (created_at),
    UNIQUE KEY unique_agent_hourly_slot (agent_extension, start_time, end_time)
);`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const conn = await mysql.createConnection(DB_CONFIG);

  try {
    await conn.query("SET time_zone = '+05:30'");
    // 1. Create database
    console.log(`\n📦 Ensuring database ${DB_NAME} exists...`);
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    );
    await conn.query(`USE \`${DB_NAME}\`;`);
    console.log(`✅ Using database: ${DB_NAME}`);

    // 2. Shared users table
    console.log('\n👤 Creating shared tables...');
    await conn.query(`
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    last_login TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);`);
    console.log('  ✅ users');

    // Default admin user
    await conn.query(`
INSERT INTO users (username, email, password)
VALUES ('Ayan Khan', 'ayan@multycomm.com', '$2b$10$8XpgD1hs3A5H5hOIGWnp6.lQMJY.xYy9.B9A1iRNJCwCJOY5pMTpO')
ON DUPLICATE KEY UPDATE username = VALUES(username);`);

    // 3. Tenant-specific APR tables
    const tenants = Object.entries(TENANT_CONFIG);
    console.log(`\n🏢 Found ${tenants.length} tenant(s): ${tenants.map(([k]) => k).join(', ')}`);

    for (const [key, config] of tenants) {
      const suffix = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
      console.log(`\n  📂 Tenant: ${config.name || key} (suffix: _${suffix})`);

      await conn.query(createAgentStatsTable(suffix));
      console.log(`    ✅ agent_stats_${suffix}`);

      await conn.query(createAgentActivityTable(suffix));
      console.log(`    ✅ agent_activity_${suffix}`);

      await conn.query(createAgentCompleteHourlyTable(suffix, key));
      console.log(`    ✅ agent_complete_hourly_${suffix}`);
    }

    console.log('\n🎉 All tables created / verified successfully.\n');

  } catch (err) {
    console.error('\n❌ Error setting up database:', err.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

main();
