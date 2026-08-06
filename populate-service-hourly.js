#!/usr/bin/env node
// populate-service-hourly.js
// Runs every hour on the hour (IST time) and fetches data for the previous completed hour
// Populates data for ALL configured tenants in parallel
// Usage: pm2 start populate-service-hourly.js --name ocube_apr_populate_hourly

import dotenv from 'dotenv';
import { populateAllTablesHourly } from './populate-final-hourly.js';
import { testConnection } from './database/config.js';
import { TENANT_CONFIG } from './tenantConfig.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Configuration
const LOG_FILE = path.join(process.cwd(), 'populate-service-hourly.log');
const STATUS_FILE = path.join(process.cwd(), 'populate-status-hourly.json');

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

// Calculate time range for the PREVIOUS completed hour in IST timezone
function calculatePreviousHourTimeRange() {
  const now = Date.now(); // Current timestamp in milliseconds
  const istOffsetMs = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
  
  // Get current time in IST
  const istTimeMs = now + istOffsetMs;
  const istDate = new Date(istTimeMs);
  
  // Get the current hour in IST (0-23)
  const istCurrentHour = istDate.getUTCHours();
  
  // Calculate the PREVIOUS hour (if current hour is 0, previous is 23 of previous day)
  const istPreviousHour = istCurrentHour === 0 ? 23 : istCurrentHour - 1;
  
  // Create start of PREVIOUS hour in IST
  let previousHourStart;
  if (istCurrentHour === 0) {
    // If current hour is 0 (midnight), previous hour is 23:00 of previous day
    const previousDay = new Date(istTimeMs - (24 * 60 * 60 * 1000));
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
      istDate.getUTCFullYear(),
      istDate.getUTCMonth(),
      istDate.getUTCDate(),
      istPreviousHour,
      0,
      0,
      0
    ));
  }
  
  const previousHourEnd = new Date(previousHourStart.getTime() + (60 * 60 * 1000)); // Add 1 hour
  
  // Convert to UTC timestamps (in seconds for API)
  const startTime = Math.floor((previousHourStart.getTime() - istOffsetMs) / 1000);
  const endTime = Math.floor((previousHourEnd.getTime() - istOffsetMs) / 1000);
  
  return { startTime, endTime, hourStart: previousHourStart, hourEnd: previousHourEnd };
}

// Format timestamp for display
function formatTimestamp(timestamp) {
  return new Date(timestamp * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
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

// Check agent tables for data (all tenants)
async function checkAgentTables() {
  log('Checking agent tables for recent data (last hour)...');
  
  const { pool } = await import('./database/config.js');
  const allTenants = Object.keys(TENANT_CONFIG);
  
  const counts = {};
  
  for (const tenant of allTenants) {
    const tables = [
      `agent_stats_${tenant}`,
      `agent_activity_${tenant}`,
      `agent_complete_hourly_${tenant}`
    ];
    
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
  }
  
  return counts;
}

// Cleanup duplicate records (all tenants)
async function cleanupDuplicateRecords() {
  try {
    const { pool } = await import('./database/config.js');
    const allTenants = Object.keys(TENANT_CONFIG);
    
    log('Cleaning up duplicate records (last hour) for all tenants...');
    
    let totalCleaned = 0;
    
    for (const tenant of allTenants) {
      const tableName = `agent_complete_hourly_${tenant}`;
      
      const cleanupQuery = `
        DELETE t1 FROM ${tableName} t1
        INNER JOIN ${tableName} t2 
        WHERE t1.id < t2.id 
        AND t1.agent_extension = t2.agent_extension 
        AND t1.start_time = t2.start_time 
        AND t1.end_time = t2.end_time
        AND t1.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
      `;
      
      const [result] = await pool.execute(cleanupQuery);
      if (result.affectedRows > 0) {
        log(`  🧹 ${tenant}: Cleaned up ${result.affectedRows} duplicate records`, 'success');
        totalCleaned += result.affectedRows;
      }
    }
    
    if (totalCleaned > 0) {
      log(`🧹 Total cleaned: ${totalCleaned} duplicate records across all tenants`, 'success');
    } else {
      log('No duplicate records found (last hour)');
    }
    
  } catch (error) {
    log(`Error in cleanup: ${error.message}`, 'error');
  }
}

// Verify data quality (all tenants)
async function verifyDataQuality() {
  try {
    const { pool } = await import('./database/config.js');
    const allTenants = Object.keys(TENANT_CONFIG);
    
    log('Data quality check for all tenants:');
    
    for (const tenant of allTenants) {
      const completeHourlyTable = `agent_complete_hourly_${tenant}`;
      const activityTable = `agent_activity_${tenant}`;
      
      try {
        const [result] = await pool.execute(`
          SELECT 
            COUNT(*) as total_records,
            COUNT(DISTINCT agent_extension) as unique_agents,
            MIN(start_time) as min_start,
            MAX(end_time) as max_end
          FROM ${completeHourlyTable}
          WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
        `);
        
        const [activityResult] = await pool.execute(`
          SELECT COUNT(DISTINCT agent_name) as agents_with_activity
          FROM ${activityTable}
          WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
        `);
        
        if (result[0].total_records > 0) {
          log(`  📊 ${tenant}:`);
          log(`     - Recent records (last hour): ${result[0].total_records}`);
          log(`     - Unique agents: ${result[0].unique_agents}`);
          log(`     - Time range: ${formatTimestamp(result[0].min_start)} to ${formatTimestamp(result[0].max_end)}`);
          log(`     - Agents with activity: ${activityResult[0].agents_with_activity}`);
        } else {
          log(`  ⚠️  ${tenant}: No recent records found`);
        }
      } catch (error) {
        log(`  ❌ ${tenant}: Error - ${error.message}`, 'error');
      }
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

// Calculate next run time (next hour on the hour in IST time)
function calculateNextRunTime() {
  const now = Date.now();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istTimeMs = now + istOffsetMs;
  const istDate = new Date(istTimeMs);
  
  // Calculate next hour on the hour
  const nextHourStart = new Date(Date.UTC(
    istDate.getUTCFullYear(),
    istDate.getUTCMonth(),
    istDate.getUTCDate(),
    istDate.getUTCHours() + 1,
    0,
    0,
    0
  ));
  
  const nextRunUtc = new Date(nextHourStart.getTime() - istOffsetMs);
  return nextRunUtc.toISOString();
}

// Main populate function
async function populateOcubeDatabase() {
  const runId = `Ocube-run-${Date.now()}`;
  const startTime = Date.now();
  
  try {
    log('');
    log('================================================================================');
    log(`Starting Ocube population (Run ID: ${runId})...`);
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
    
    // Step 2: Calculate previous hour time range
    let dbStartTime, dbEndTime, hourStart, hourEnd;
    ({ startTime: dbStartTime, endTime: dbEndTime, hourStart, hourEnd } = calculatePreviousHourTimeRange());
    
    log(`Step 2: Fetching previous completed hour data`);
    log(`   📅 Time Range: ${formatTimestamp(dbStartTime)} → ${formatTimestamp(dbEndTime)}`);
    log(`   🕐 IST Time: ${hourStart.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} → ${hourEnd.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    
    // Step 3: Check current state
    log('Step 3: Checking current state of agent tables...');
    const beforeCounts = await checkAgentTables();
    
    // Step 4: Run the populate process for ALL tenants in parallel
    const allTenants = Object.keys(TENANT_CONFIG);
    log(`Step 4: Running Ocube agent data population for ${allTenants.length} tenants...`);
    log(`   Tenants: ${allTenants.join(', ')}`);
    log(`   Time Range: ${dbStartTime} → ${dbEndTime}`);
    
    const results = await Promise.allSettled(
      allTenants.map(tenantKey =>
        populateAllTablesHourly(dbStartTime, dbEndTime, tenantKey)
          .then(result => ({ tenant: tenantKey, success: result }))
          .catch(error => ({ tenant: tenantKey, success: false, error: error.message }))
      )
    );
    
    // Log results for each tenant
    log('\n📊 TENANT POPULATION RESULTS:');
    let successCount = 0;
    let failCount = 0;
    
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        const { tenant, success, error } = result.value;
        if (success) {
          log(`  ✅ ${tenant}: SUCCESS`, 'success');
          successCount++;
        } else {
          log(`  ❌ ${tenant}: FAILED - ${error || 'Unknown error'}`, 'error');
          failCount++;
        }
      } else {
        log(`  ❌ Tenant processing failed: ${result.reason}`, 'error');
        failCount++;
      }
    });
    
    log(`\n📈 Summary: ${successCount} succeeded, ${failCount} failed out of ${allTenants.length} tenants`);
    
    if (failCount === allTenants.length) {
      throw new Error('All tenant populations failed');
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
    await verifyDataQuality();
    
    // Calculate duration
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    log('');
    log('================================================================================');
    log(`🎉 Population completed successfully in ${duration}s!`, 'success');
    log(`📊 Mode: Previous Hour Fetch`);
    log(`📈 Records Added: ${totalNewRecords}`);
    const nextRun = new Date(calculateNextRunTime());
    const nextRunIST = nextRun.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    log(`⏰ Next run: ${nextRunIST} (at next hour)`, 'success');
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
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istTimeMs = now + istOffsetMs;
  const istDate = new Date(istTimeMs);
  
  // Calculate milliseconds until next hour on the hour
  const minutesUntilNextHour = 60 - istDate.getUTCMinutes();
  const secondsUntilNextHour = 60 - istDate.getUTCSeconds();
  const msUntilNextHour = (minutesUntilNextHour - 1) * 60 * 1000 + secondsUntilNextHour * 1000;
  
  const nextRunTime = new Date(now + msUntilNextHour);
  const nextRunIST = nextRunTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  
  log(`⏰ Next population scheduled for: ${nextRunIST} IST time (in ${Math.floor(msUntilNextHour / 60000)} minutes)`, 'success');
  
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
    await populateOcubeDatabase();
    scheduleNextRun(); // Schedule the next run after this one completes
  }, msUntilNextHour);
}

// Initialize service
async function initializeService() {
  const allTenants = Object.keys(TENANT_CONFIG);
  
  // Create log file header
  const header = `
=========================================
OCUBE POPULATE SERVICE - HOURLY ON THE HOUR
=========================================
Date: ${new Date().toISOString()}
Interval: Every hour on the hour (IST time)
Mode: Fetch previous completed hour
Tenants: ${allTenants.join(', ')}
Total Tenants: ${allTenants.length}
=========================================
`;
  
  fs.writeFileSync(LOG_FILE, header);
  log(`Service configured to run every hour on the hour (IST time)`);
  log(`Populating data for ${allTenants.length} tenants: ${allTenants.join(', ')}`);
  log('Log file initialized');
  
  // Run initial population immediately
  log('Starting initial population run for all tenants...');
  await populateOcubeDatabase();
  
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
