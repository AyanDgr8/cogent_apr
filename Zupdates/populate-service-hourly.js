#!/usr/bin/env node
// populate-service-hourly.js
// Runs every hour on the hour (Dubai time) and fetches data for the previous completed hour
// Usage: pm2 start populate-service-hourly.js --name spc_apr_populate_hourly

import dotenv from 'dotenv';
import { populateAllTablesHourly } from './populate-final-hourly.js';
import { testConnection } from './database/config.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Configuration
const LOG_FILE = path.join(process.cwd(), 'spc-populate-service-hourly.log');
const STATUS_FILE = path.join(process.cwd(), 'spc-populate-status-hourly.json');

// Logging function
function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${getLogPrefix(level)} ${message}\n`;
  
  console.log(logMessage.trim());
  
  try {
    fs.appendFileSync(LOG_FILE, logMessage);
  } catch (error) {
    console.error('Failed to write to log file:', error.message);
  }
}

function getLogPrefix(level) {
  const prefixes = {
    info: 'ℹ️ INFO:',
    success: '✅ SUCCESS:',
    error: '❌ ERROR:',
    warning: '⚠️ WARNING:'
  };
  return prefixes[level] || 'ℹ️ INFO:';
}

// Calculate time range for the PREVIOUS completed hour in Dubai timezone
function calculatePreviousHourTimeRange() {
  const now = Date.now(); // Current timestamp in milliseconds
  const dubaiOffsetMs = 4 * 60 * 60 * 1000; // Dubai is UTC+4
  
  // Get current time in Dubai
  const dubaiTimeMs = now + dubaiOffsetMs;
  const dubaiDate = new Date(dubaiTimeMs);
  
  // Get the current hour in Dubai (0-23)
  const dubaiCurrentHour = dubaiDate.getUTCHours();
  
  // Calculate the PREVIOUS hour (if current hour is 0, previous is 23 of previous day)
  const dubaiPreviousHour = dubaiCurrentHour === 0 ? 23 : dubaiCurrentHour - 1;
  
  // Create start of PREVIOUS hour in Dubai
  let previousHourStart;
  if (dubaiCurrentHour === 0) {
    // If current hour is 0 (midnight), previous hour is 23:00 of previous day
    const previousDay = new Date(dubaiTimeMs - (24 * 60 * 60 * 1000));
    previousHourStart = new Date(Date.UTC(
      previousDay.getUTCFullYear(),
      previousDay.getUTCMonth(),
      previousDay.getUTCDate(),
      23,
      0,
      0,
      0
    ));
  } else {
    previousHourStart = new Date(Date.UTC(
      dubaiDate.getUTCFullYear(),
      dubaiDate.getUTCMonth(),
      dubaiDate.getUTCDate(),
      dubaiPreviousHour,
      0,
      0,
      0
    ));
  }
  
  const previousHourEnd = new Date(previousHourStart.getTime() + (60 * 60 * 1000)); // Add 1 hour
  
  // Convert to UTC timestamps (in seconds for API)
  const startTime = Math.floor((previousHourStart.getTime() - dubaiOffsetMs) / 1000);
  const endTime = Math.floor((previousHourEnd.getTime() - dubaiOffsetMs) / 1000);
  
  return { startTime, endTime, hourStart: previousHourStart, hourEnd: previousHourEnd };
}

// Format timestamp for display
function formatTimestamp(timestamp) {
  return new Date(timestamp * 1000).toLocaleString('en-AE', {
    timeZone: 'Asia/Dubai',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Check database connection
async function checkDatabaseConnection() {
  log('Checking database connection...');
  try {
    await testConnection();
    log('Database connection successful', 'success');
    return true;
  } catch (error) {
    log(`Database connection failed: ${error.message}`, 'error');
    return false;
  }
}

async function validateActivityEventIndex() {
  const { pool } = await import('./database/config.js');
  const [indexes] = await pool.query(
    `SHOW INDEX FROM agent_activity WHERE Key_name = 'unique_agent_activity'`
  );
  const columns = indexes
    .sort((a, b) => a.Seq_in_index - b.Seq_in_index)
    .map(index => index.Column_name);
  const expected = ['agent_name', 'event_timestamp', 'event_type', 'event_state'];
  if (columns.join(',') !== expected.join(',')) {
    throw new Error(
      `agent_activity unique index is incompatible (${columns.join(', ') || 'missing'}). ` +
      `Expected: ${expected.join(', ')}. Apply database/schema.sql before starting the hourly service.`
    );
  }
  log('Activity-event uniqueness index supports simultaneous transitions', 'success');
}

// Check agent tables for data
async function checkAgentTables() {
  log('Checking agent tables for recent data (last hour)...');
  
  const { pool } = await import('./database/config.js');
  
  const tables = [
    'agent_stats',
    'agent_activity',
    'agent_complete_hourly'
  ];
  
  const counts = {};
  
  for (const table of tables) {
    try {
      const [result] = await pool.execute(
        `SELECT COUNT(*) as count FROM ${table} WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`
      );
      counts[table] = result[0].count;
      log(`${table} (last hour): ${result[0].count} records`);
    } catch (error) {
      log(`Error checking ${table}: ${error.message}`, 'error');
      counts[table] = 0;
    }
  }
  
  return counts;
}

// Cleanup duplicate records
async function cleanupDuplicateRecords() {
  try {
    const { pool } = await import('./database/config.js');
    
    log('Cleaning up duplicate records (last hour)...');
    
    const cleanupQuery = `
      DELETE t1 FROM agent_complete_hourly t1
      INNER JOIN agent_complete_hourly t2 
      WHERE t1.id < t2.id 
      AND t1.agent_extension = t2.agent_extension 
      AND t1.start_time = t2.start_time 
      AND t1.end_time = t2.end_time
      AND t1.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `;
    
    const [result] = await pool.execute(cleanupQuery);
    if (result.affectedRows > 0) {
      log(`🧹 Cleaned up ${result.affectedRows} duplicate records`, 'success');
    } else {
      log('No duplicate records found (last hour)');
    }
    
  } catch (error) {
    log(`Error in cleanup: ${error.message}`, 'error');
  }
}

// Verify data quality
async function verifyDataQuality(slotStart, slotEnd) {
  try {
    const { pool } = await import('./database/config.js');
    
    const [result] = await pool.execute(`
      SELECT 
        COUNT(*) as total_records,
        COUNT(DISTINCT agent_extension) as unique_agents,
        MIN(start_time) as min_start,
        MAX(end_time) as max_end
      FROM agent_complete_hourly
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `);
    
    const [activityResult] = await pool.execute(`
      SELECT COUNT(DISTINCT agent_name) as agents_with_activity
      FROM agent_activity
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `);

    const [timingResult] = await pool.execute(`
      SELECT
        COUNT(*) AS rows_in_slot,
        SUM(
          TIME_TO_SEC(idle_time) + TIME_TO_SEC(wrap_up_time) +
          TIME_TO_SEC(hold_time) + TIME_TO_SEC(on_call_time) >
          TIME_TO_SEC(available_time)
        ) AS available_state_overlaps,
        SUM(
          ABS(
            TIME_TO_SEC(login_time) - TIME_TO_SEC(available_time) -
            TIME_TO_SEC(not_available_time)
          ) > 1
        ) AS registration_mismatches
      FROM agent_complete_hourly
      WHERE start_time = ? AND end_time = ?
    `, [slotStart, slotEnd]);
    
    if (result[0].total_records > 0) {
      log('Data quality check:');
      log(`  - Recent records (last hour): ${result[0].total_records}`);
      log(`  - Unique agents: ${result[0].unique_agents}`);
      log(`  - Time range: ${formatTimestamp(result[0].min_start)} to ${formatTimestamp(result[0].max_end)}`);
      log(`  - Agents with call activity: ${activityResult[0].agents_with_activity}`);
      log(`  - Rows in populated slot: ${timingResult[0].rows_in_slot}`);
      log(`  - Available-state overlaps: ${timingResult[0].available_state_overlaps || 0}`,
        timingResult[0].available_state_overlaps > 0 ? 'warning' : 'success');
      log(`  - Registration mismatches: ${timingResult[0].registration_mismatches || 0}`,
        timingResult[0].registration_mismatches > 0 ? 'warning' : 'success');
    }
  } catch (error) {
    log(`Error verifying data quality: ${error.message}`, 'error');
  }
}

// Update status file
function updateStatusFile(status) {
  try {
    const statusData = {
      lastRun: new Date().toISOString(),
      status: status,
      nextRun: calculateNextRunTime()
    };
    
    fs.writeFileSync(STATUS_FILE, JSON.stringify(statusData, null, 2));
  } catch (error) {
    log(`Failed to update status file: ${error.message}`, 'error');
  }
}

// Calculate next run time (next hour on the hour in Dubai time)
function calculateNextRunTime() {
  const now = Date.now();
  const dubaiOffsetMs = 4 * 60 * 60 * 1000;
  const dubaiTimeMs = now + dubaiOffsetMs;
  const dubaiDate = new Date(dubaiTimeMs);
  
  // Calculate next hour on the hour
  const nextHourStart = new Date(Date.UTC(
    dubaiDate.getUTCFullYear(),
    dubaiDate.getUTCMonth(),
    dubaiDate.getUTCDate(),
    dubaiDate.getUTCHours() + 1,
    0,
    0,
    0
  ));
  
  const nextRunUtc = new Date(nextHourStart.getTime() - dubaiOffsetMs);
  return nextRunUtc.toISOString();
}

// Main populate function
async function populateSPCDatabase() {
  const runId = `spc-run-${Date.now()}`;
  const startTime = Date.now();
  
  try {
    log('');
    log('================================================================================');
    log(`Starting SPC population (Run ID: ${runId})...`);
    log('⏰ Interval: Every hour on the hour');
    log('📊 Mode: Fetch previous completed hour');
    log('================================================================================');
    log('');
    
    // Step 1: Check database connection
    log('Step 1: Checking database connection...');
    const dbConnected = await checkDatabaseConnection();
    if (!dbConnected) {
      throw new Error('Database connection failed');
    }
    await validateActivityEventIndex();
    
    // Step 2: Calculate previous hour time range
    let dbStartTime, dbEndTime, hourStart, hourEnd;
    ({ startTime: dbStartTime, endTime: dbEndTime, hourStart, hourEnd } = calculatePreviousHourTimeRange());
    
    log(`Step 2: Fetching previous completed hour data`);
    log(`   📅 Time Range: ${formatTimestamp(dbStartTime)} → ${formatTimestamp(dbEndTime)}`);
    log(`   🕐 Dubai Time: ${hourStart.toLocaleString('en-AE', { timeZone: 'Asia/Dubai' })} → ${hourEnd.toLocaleString('en-AE', { timeZone: 'Asia/Dubai' })}`);
    
    // Step 3: Check current state
    log('Step 3: Checking current state of agent tables...');
    const beforeCounts = await checkAgentTables();
    
    // Step 4: Run the populate process
    log(`Step 4: Running SPC agent data population...`);
    log(`Executing: populateAllTablesHourly(${dbStartTime}, ${dbEndTime})`);
    
    const populateResult = await populateAllTablesHourly(dbStartTime, dbEndTime);
    
    if (populateResult) {
      log('SPC agent data population completed successfully', 'success');
    } else {
      log('SPC agent data population returned no result', 'warning');
    }
    
    // Step 5: Check after population
    log('Step 5: Checking agent tables after population...');
    const afterCounts = await checkAgentTables();
    
    // Calculate differences
    for (const table of Object.keys(beforeCounts)) {
      const diff = afterCounts[table] - beforeCounts[table];
      if (diff > 0) {
        log(`${table}: +${diff} new records`, 'success');
      } else {
        log(`${table}: No new records added`);
      }
    }
    
    const totalNewRecords = Object.keys(beforeCounts).reduce((sum, table) => {
      return sum + (afterCounts[table] - beforeCounts[table]);
    }, 0);
    
    log(`Total new records added across all tables: ${totalNewRecords}`, 'success');
    
    // Step 6: Cleanup duplicates
    log('Step 6: Cleaning up duplicate records...');
    await cleanupDuplicateRecords();
    
    // Step 7: Verify data quality
    log('Step 7: Verifying data quality...');
    await verifyDataQuality(dbStartTime, dbEndTime);
    
    // Calculate duration
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    log('');
    log('================================================================================');
    log(`🎉 Population completed successfully in ${duration}s!`, 'success');
    log(`📊 Mode: Previous Hour Fetch`);
    log(`📈 Records Added: ${totalNewRecords}`);
    const nextRun = new Date(calculateNextRunTime());
    const nextRunDubai = nextRun.toLocaleString('en-AE', { timeZone: 'Asia/Dubai' });
    log(`⏰ Next run: ${nextRunDubai} (at next hour)`, 'success');
    log('================================================================================');
    log('');
    
    updateStatusFile('success');
    
  } catch (error) {
    log(`Population failed: ${error.message}`, 'error');
    log(`Stack trace: ${error.stack}`, 'error');
    updateStatusFile('error');
    throw error;
  }
}

// Schedule next run
function scheduleNextRun() {
  const now = Date.now();
  const dubaiOffsetMs = 4 * 60 * 60 * 1000;
  const dubaiTimeMs = now + dubaiOffsetMs;
  const dubaiDate = new Date(dubaiTimeMs);
  
  // Calculate milliseconds until next hour on the hour
  const minutesUntilNextHour = 60 - dubaiDate.getUTCMinutes();
  const secondsUntilNextHour = 60 - dubaiDate.getUTCSeconds();
  const msUntilNextHour = (minutesUntilNextHour - 1) * 60 * 1000 + secondsUntilNextHour * 1000;
  
  const nextRunTime = new Date(now + msUntilNextHour);
  const nextRunDubai = nextRunTime.toLocaleString('en-AE', { timeZone: 'Asia/Dubai' });
  
  log(`⏰ Next population scheduled for: ${nextRunDubai} Dubai time (in ${Math.floor(msUntilNextHour / 60000)} minutes)`, 'success');
  
  // Schedule countdown logs for last 5 minutes
  const countdownIntervals = [5, 4, 3, 2, 1];
  countdownIntervals.forEach(minutes => {
    const countdownTime = msUntilNextHour - (minutes * 60 * 1000);
    if (countdownTime > 0) {
      setTimeout(() => {
        log(`⏳ Next population in ${minutes} minute${minutes > 1 ? 's' : ''}...`);
      }, countdownTime);
    }
  });
  
  setTimeout(async () => {
    log('🚀 Starting scheduled population run...');
    await populateSPCDatabase();
    scheduleNextRun(); // Schedule the next run after this one completes
  }, msUntilNextHour);
}

// Initialize service
async function initializeService() {
  // Create log file header
  const header = `
=========================================
SPC POPULATE SERVICE - HOURLY ON THE HOUR
=========================================
Date: ${new Date().toISOString()}
Interval: Every hour on the hour (Dubai time)
Mode: Fetch previous completed hour
Tenant: ${process.env.TENANT || 'spc'}
=========================================
`;
  
  fs.writeFileSync(LOG_FILE, header);
  log('Service configured to run every hour on the hour (Dubai time)');
  log('Log file initialized');
  
  // Run initial population immediately
  log('Starting initial population run...');
  await populateSPCDatabase();
  
  // Schedule subsequent runs
  scheduleNextRun();
}

// Start the service
initializeService().catch(error => {
  console.error('Failed to initialize service:', error);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  log('Received SIGINT. Shutting down gracefully...', 'warning');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM. Shutting down gracefully...', 'warning');
  process.exit(0);
});
