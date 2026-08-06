// populate-service.js
// A robust service script to automatically populate the Meydan agent database at regular intervals
// Usage: node meydan-populate-service.js [intervalMinutes] [lookbackHours]
// Example: node meydan-populate-service.js 5 1

import dotenv from 'dotenv';
import { populateAllTablesHourly } from './populate-final-hourly.js';
import { testConnection } from './database/config.js';
import fs from 'fs';
import path from 'path';

dotenv.config();
process.env.TZ = 'Asia/Kolkata';

// Default configuration
const DEFAULT_INTERVAL_MINUTES = 5;
const LOG_FILE = path.join(process.cwd(), 'meydan-populate-service.log');
const STATUS_FILE = path.join(process.cwd(), 'meydan-populate-status.json');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  
  // Get interval in minutes (default: 5 minutes)
  const intervalMinutes = args.length >= 1 ? parseInt(args[0], 10) : DEFAULT_INTERVAL_MINUTES;
  
  return {
    intervalMinutes: isNaN(intervalMinutes) ? DEFAULT_INTERVAL_MINUTES : intervalMinutes
  };
}

// Custom logging function that writes to both console and log file
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  let formattedMessage;
  
  switch (type) {
    case 'error':
      formattedMessage = `[${timestamp}] ❌ ERROR: ${message}`;
      console.error(formattedMessage);
      break;
    case 'warning':
      formattedMessage = `[${timestamp}] ⚠️ WARNING: ${message}`;
      console.warn(formattedMessage);
      break;
    case 'success':
      formattedMessage = `[${timestamp}] ✅ SUCCESS: ${message}`;
      console.log(formattedMessage);
      break;
    default:
      formattedMessage = `[${timestamp}] ℹ️ INFO: ${message}`;
      console.log(formattedMessage);
  }
  
  // Append to log file
  try {
    fs.appendFileSync(LOG_FILE, formattedMessage + '\n');
  } catch (error) {
    console.error(`Failed to write to log file: ${error.message}`);
  }
  
  return formattedMessage;
}

// Function to check database connection
async function checkDatabaseConnection() {
  log('Checking database connection...');
  
  try {
    const isConnected = await testConnection();
    if (isConnected) {
      log('Database connection successful', 'success');
      return true;
    } else {
      log('Database connection failed', 'error');
      return false;
    }
  } catch (error) {
    log(`Database connection error: ${error.message}`, 'error');
    return false;
  }
}

// Function to check agent tables for data (optimized to check only last hour)
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
      // Only count records from the last hour to speed up the query
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

// Function to calculate time range based on current hour in IST
function calculateTimeRange() {
  const now = Date.now(); // Current timestamp in milliseconds
  
  // IST is UTC+5:30
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  
  const istTimeMs = now + istOffsetMs;
  const istDate = new Date(istTimeMs);
  
  const istHour = istDate.getUTCHours();
  
  // Create start of current hour in IST
  const currentHourStart = new Date(Date.UTC(
    istDate.getUTCFullYear(),
    istDate.getUTCMonth(),
    istDate.getUTCDate(),
    istHour,
    0,
    0,
    0
  ));
  
  const currentHourEnd = new Date(currentHourStart.getTime() + (60 * 60 * 1000)); // Add 1 hour
  
  // Convert to UTC timestamps (in seconds for API)
  const startTime = Math.floor((currentHourStart.getTime() - istOffsetMs) / 1000);
  const endTime = Math.floor((currentHourEnd.getTime() - istOffsetMs) / 1000);
  
  log(`🔍 DEBUG: Current time calculation:`);
  log(`   - System time (UTC): ${new Date(now).toISOString()}`);
  log(`   - IST time: ${new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
  log(`   - IST hour: ${istHour}`);
  log(`   - IST hour start: ${formatTimestamp(startTime)}`);
  log(`   - IST hour end: ${formatTimestamp(endTime)}`);
  log(`   - UTC hour start: ${new Date(startTime * 1000).toISOString()} (${startTime})`);
  log(`   - UTC hour end: ${new Date(endTime * 1000).toISOString()} (${endTime})`);
  
  return { startTime, endTime };
}


// Function to format timestamp for display
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

// Main function to populate Meydan agent database
async function populateMeydanDatabase() {
  const startTime = Date.now();
  const runId = `meydan-run-${Date.now()}`;
  log(`Starting Meydan agent database population process (ID: ${runId})...`);
  
  try {
    // Step 1: Check database connection
    log('Step 1: Checking database connection...');
    const isConnected = await checkDatabaseConnection();
    if (!isConnected) {
      throw new Error('Database connection failed');
    }
    
    // Step 2: Calculate time range (always use current hour for populate service)
    let dbStartTime, dbEndTime;
    ({ startTime: dbStartTime, endTime: dbEndTime } = calculateTimeRange());
    log(`Step 2: Using current hour range: ${formatTimestamp(dbStartTime)} to ${formatTimestamp(dbEndTime)}`);
    log(`Processing current hour only to avoid duplicates and ensure correct call assignment`);
    
    // Step 3: Check current state of agent tables
    log('Step 3: Checking current state of agent tables...');
    const beforeCounts = await checkAgentTables();
    
    // Step 4: Run the populate process
    log('Step 4: Running Meydan agent data population...');
    log(`Executing: populateAllTablesHourly(${dbStartTime}, ${dbEndTime})`);
    
    // Run the populate function with progressive loading
    const populateResult = await populateAllTablesHourly(dbStartTime, dbEndTime);
    
    if (populateResult) {
      log('Meydan agent data population completed successfully', 'success');
    } else {
      throw new Error('Population function returned false');
    }
    
    // Step 5: Check agent tables after population
    log('Step 5: Checking agent tables after population...');
    const afterCounts = await checkAgentTables();
    
    // Calculate new records added
    const newRecords = {};
    let totalNewRecords = 0;
    
    for (const table in afterCounts) {
      if (beforeCounts[table] !== undefined) {
        newRecords[table] = afterCounts[table] - beforeCounts[table];
        totalNewRecords += newRecords[table];
        
        if (newRecords[table] > 0) {
          log(`${table}: +${newRecords[table]} new records`, 'success');
        } else if (newRecords[table] === 0) {
          log(`${table}: No new records added`);
        } else {
          log(`${table}: ${newRecords[table]} records (possible cleanup)`, 'warning');
        }
      }
    }
    
    log(`Total new records added across all tables: ${totalNewRecords}`, 'success');
    
    // Step 6: Clean up any duplicate records
    log('Step 6: Cleaning up duplicate records...');
    await cleanupDuplicateRecords();
    
    // Step 7: Verify data quality
    log('Step 7: Verifying data quality...');
    await verifyDataQuality();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const nextRunTime = new Date(Date.now() + (config.intervalMinutes * 60 * 1000));
    
    log(`🎉 Meydan agent database population completed successfully in ${duration}s!`, 'success');
    log(`📅 Next population scheduled for: ${nextRunTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST (in ${config.intervalMinutes} minutes)`, 'success');
    
    // Update status file with last successful run
    updateStatusFile({
      lastRun: new Date().toISOString(),
      status: 'success',
      duration: `${duration}s`,
      timeRange: {
        start: formatTimestamp(dbStartTime),
        end: formatTimestamp(dbEndTime),
        startTimestamp: dbStartTime,
        endTimestamp: dbEndTime
      },
      recordsAdded: newRecords,
      totalNewRecords: totalNewRecords,
      nextRun: nextRunTime.toISOString()
    });
    
    return true;
  } catch (error) {
    log(`Error in Meydan database population process (ID: ${runId}): ${error.message}`, 'error');
    log(error.stack, 'error');
    
    // Update status file with error information
    updateStatusFile({
      lastRun: new Date().toISOString(),
      status: 'error',
      error: error.message,
      stack: error.stack,
      nextRun: new Date(Date.now() + (config.intervalMinutes * 60 * 1000)).toISOString()
    });
    
    return false;
  }
}

// Function to clean up duplicate records (optimized to check only last hour)
async function cleanupDuplicateRecords() {
  try {
    const { pool } = await import('./database/config.js');
    
    log('Cleaning up duplicate records (last hour)...');
    
    // Clean up duplicates in agent_complete_hourly table (only last hour)
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
      log(`🧹 Cleaned up ${result.affectedRows} duplicate records (last hour)`, 'success');
    } else {
      log('No duplicate records found (last hour)');
    }
    
  } catch (error) {
    log(`Error in cleanup: ${error.message}`, 'error');
  }
}

// Function to verify data quality
async function verifyDataQuality() {
  try {
    const { pool } = await import('./database/config.js');
    
    // Check for recent data in agent_complete_hourly
    const recentDataQuery = `
      SELECT 
        COUNT(*) as total_records,
        COUNT(DISTINCT agent_name) as unique_agents,
        MIN(start_time) as earliest_time,
        MAX(end_time) as latest_time
      FROM agent_complete_hourly 
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `;
    
    const [recentData] = await pool.execute(recentDataQuery);
    const data = recentData[0];
    
    log(`Data quality check:`);
    log(`  - Recent records (last hour): ${data.total_records}`);
    log(`  - Unique agents: ${data.unique_agents}`);
    
    if (data.earliest_time && data.latest_time) {
      log(`  - Time range: ${formatTimestamp(data.earliest_time)} to ${formatTimestamp(data.latest_time)}`);
    }
    
    // Check for agents with call activity
    const activeAgentsQuery = `
      SELECT COUNT(*) as active_agents
      FROM agent_complete_hourly 
      WHERE total_calls > 0 
      AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `;
    
    const [activeAgents] = await pool.execute(activeAgentsQuery);
    log(`  - Agents with call activity: ${activeAgents[0].active_agents}`);
    
    // Check for custom states data
    const customStatesQuery = `
      SELECT COUNT(*) as records_with_states
      FROM agent_complete_hourly 
      WHERE custom_states IS NOT NULL 
      AND custom_states != ''
      AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `;
    
    const [customStates] = await pool.execute(customStatesQuery);
    log(`  - Records with custom states: ${customStates[0].records_with_states}`);
    
  } catch (error) {
    log(`Error in data quality verification: ${error.message}`, 'error');
  }
}

// Function to update status file
function updateStatusFile(status) {
  try {
    // Read existing status if available
    let currentStatus = {};
    if (fs.existsSync(STATUS_FILE)) {
      const statusContent = fs.readFileSync(STATUS_FILE, 'utf8');
      currentStatus = JSON.parse(statusContent);
    }
    
    // Update with new status
    const updatedStatus = {
      ...currentStatus,
      ...status,
      lastUpdated: new Date().toISOString(),
      config: {
        intervalMinutes: config.intervalMinutes,
        lookbackHours: config.lookbackHours
      }
    };
    
    // Write updated status
    fs.writeFileSync(STATUS_FILE, JSON.stringify(updatedStatus, null, 2));
  } catch (error) {
    log(`Error updating status file: ${error.message}`, 'error');
  }
}

// Function to run the service with error handling and recovery
async function runService() {
  try {
    await populateMeydanDatabase();
  } catch (error) {
    log(`Critical service error: ${error.message}`, 'error');
    log(error.stack, 'error');
  }
  
  // Schedule next run regardless of success or failure
  scheduleNextRun();
}

// Function to schedule the next run
function scheduleNextRun() {
  const intervalMs = config.intervalMinutes * 60 * 1000;
  const nextRunTime = new Date(Date.now() + intervalMs);
  const istTime = nextRunTime.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  
  log(`⏰ Next population scheduled for: ${istTime} IST (in ${config.intervalMinutes} minutes)`, 'success');
  
  // Update status file with next run time
  updateStatusFile({
    nextRun: nextRunTime.toISOString(),
    nextRunIST: istTime,
    status: 'waiting_for_next_run'
  });
  
  // Show countdown updates every minute for intervals >= 5 minutes
  if (config.intervalMinutes >= 5) {
    const countdownInterval = setInterval(() => {
      const timeLeft = nextRunTime.getTime() - Date.now();
      const minutesLeft = Math.ceil(timeLeft / (60 * 1000));
      
      if (minutesLeft <= 0) {
        clearInterval(countdownInterval);
      } else if (minutesLeft <= 5 && minutesLeft % 1 === 0) {
        log(`⏳ Next population in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}...`);
      }
    }, 60000); // Check every minute
  }
  
  setTimeout(() => {
    log('🚀 Starting scheduled Meydan population run...', 'info');
    runService();
  }, intervalMs);
}

// Initialize log file
function initializeLogFile() {
  const header = `
=========================================
MEYDAN AGENT DATABASE POPULATE SERVICE STARTED
=========================================
Date: ${new Date().toISOString()}
Interval: ${config.intervalMinutes} minutes
Lookback: ${config.lookbackHours} hours
Tenant: ${process.env.TENANT || 'meydan'}
=========================================
`;
  
  // Create or append to log file (don't truncate existing logs)
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, header);
  } else {
    fs.appendFileSync(LOG_FILE, header);
  }
  log('Log file initialized');
}

// Parse configuration from command line arguments
const config = parseArgs();
log(`Service configured with: ${config.intervalMinutes} minute intervals (no lookback period)`);

// Initialize
(async () => {
  // Initialize log file
  initializeLogFile();
  
  // Create initial status file
  updateStatusFile({
    serviceStarted: new Date().toISOString(),
    status: 'starting',
    config: {
      intervalMinutes: config.intervalMinutes,
      lookbackHours: config.lookbackHours,
      tenant: process.env.TENANT || 'meydan'
    }
  });
  
  // Start the service
  log('Starting initial Meydan agent database population run...');
  await runService();
})();

// Handle graceful shutdown
process.on('SIGINT', () => {
  log('Received SIGINT. Shutting down Meydan populate service gracefully...', 'warning');
  updateStatusFile({
    status: 'stopped',
    reason: 'SIGINT received',
    stoppedAt: new Date().toISOString()
  });
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM. Shutting down Meydan populate service gracefully...', 'warning');
  updateStatusFile({
    status: 'stopped',
    reason: 'SIGTERM received',
    stoppedAt: new Date().toISOString()
  });
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log(`Uncaught exception: ${error.message}`, 'error');
  log(error.stack, 'error');
  updateStatusFile({
    status: 'crashed',
    error: error.message,
    stack: error.stack,
    crashedAt: new Date().toISOString()
  });
  
  // Give time for logs to be written before exiting
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  log(`Unhandled promise rejection at: ${promise}, reason: ${reason}`, 'error');
  updateStatusFile({
    status: 'crashed',
    error: `Unhandled promise rejection: ${reason}`,
    crashedAt: new Date().toISOString()
  });
  
  // Give time for logs to be written before exiting
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

export default {
  populateMeydanDatabase,
  config,
  log
};
