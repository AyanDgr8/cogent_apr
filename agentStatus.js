// agentStatus.js
// Fetch Agents Status & Activity report for a tenant and output to
// stdout (table) or write to a file (CSV or JSON).
//
// Usage examples:
//   node -r dotenv/config agentStatus.js mc_int 2025-07-02T08:00:00Z 2025-07-02T12:00:00Z
//   node -r dotenv/config agentStatus.js mc_int 2025-07-02T08:00:00Z 2025-07-02T12:00:00Z report.csv
//
// The script automatically handles pagination, retries (exp backoff),
// and self-signed certificates (inherits httpsAgent from tokenService).

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { getApiKeyHeaders, httpsAgent } from './tokenService.js';
import { getTenantConfig } from './tenantConfig.js';

const MAX_RETRIES = 3;

/**
 * Convert an array of plain objects to a CSV string.
 * Very small helper to avoid a new dependency.
 */
function toCsv(records, delimiter = ',') {
  if (!records.length) return '';
  const header = Object.keys(records[0]).join(delimiter);
  const rows = records.map(r =>
    Object.values(r)
      .map(v => {
        if (v == null) return '';
        const str = String(v);
        return str.includes(delimiter) || str.includes('\n') || str.includes('"')
          ? `"${str.replace(/"/g, '""')}"` // escape quotes per RFC4180
          : str;
      })
      .join(delimiter)
  );
  return [header, ...rows].join('\n');
}

/**
 * Convert Unix timestamp to dd/mm/yyyy, hh:mm:ss format
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} - Formatted date string
 */
function formatTimestamp(timestamp) {
  const date = new Date(timestamp * 1000); // Convert to milliseconds
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  
  return `${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
}

/**
 * Format agent events data into a properly aligned table
 * @param {object} responseData - The API response containing agent events
 * @returns {string} - Formatted table string
 */
function formatAgentEventsTable(responseData) {
  if (!responseData || !responseData.data || !Array.isArray(responseData.data)) {
    return 'No data available';
  }

  const data = responseData.data;
  
  // Define column headers and their display widths
  const headers = {
    event: 'Event',
    enabled: 'Enabled',
    user_id: 'User ID',
    ext: 'Ext',
    username: 'Username',
    state: 'State',
    timestamp: 'Timestamp'
  };

  // Calculate column widths based on content
  const columnWidths = {
    event: Math.max(headers.event.length, Math.max(...data.map(row => row.event?.length || 0))),
    enabled: Math.max(headers.enabled.length, 7), // 'true'/'false'
    user_id: Math.max(headers.user_id.length, Math.max(...data.map(row => row.user_id?.length || 0))),
    ext: Math.max(headers.ext.length, Math.max(...data.map(row => String(row.ext || '').length))),
    username: Math.max(headers.username.length, Math.max(...data.map(row => row.username?.length || 0))),
    state: Math.max(headers.state.length, Math.max(...data.map(row => row.state?.length || 0))),
    timestamp: Math.max(headers.timestamp.length, 19) // dd/mm/yyyy, hh:mm:ss
  };

  // Helper function to pad strings
  const pad = (str, width) => String(str || '').padEnd(width);

  // Create table header
  const headerRow = `| ${pad(headers.event, columnWidths.event)} | ${pad(headers.enabled, columnWidths.enabled)} | ${pad(headers.user_id, columnWidths.user_id)} | ${pad(headers.ext, columnWidths.ext)} | ${pad(headers.username, columnWidths.username)} | ${pad(headers.state, columnWidths.state)} | ${pad(headers.timestamp, columnWidths.timestamp)} |`;
  
  // Create separator row
  const separatorRow = `|${'-'.repeat(columnWidths.event + 2)}|${'-'.repeat(columnWidths.enabled + 2)}|${'-'.repeat(columnWidths.user_id + 2)}|${'-'.repeat(columnWidths.ext + 2)}|${'-'.repeat(columnWidths.username + 2)}|${'-'.repeat(columnWidths.state + 2)}|${'-'.repeat(columnWidths.timestamp + 2)}|`;

  // Create data rows
  const dataRows = data.map(row => {
    const formattedTimestamp = formatTimestamp(row.Timestamp);
    const enabledValue = String(row.enabled); // Convert boolean to string explicitly
    return `| ${pad(row.event, columnWidths.event)} | ${pad(enabledValue, columnWidths.enabled)} | ${pad(row.user_id, columnWidths.user_id)} | ${pad(row.ext, columnWidths.ext)} | ${pad(row.username, columnWidths.username)} | ${pad(row.state, columnWidths.state)} | ${pad(formattedTimestamp, columnWidths.timestamp)} |`;
  });

  // Combine all parts
  return [headerRow, separatorRow, ...dataRows].join('\n');
}

/**
 * Display agent events data in a formatted table
 * @param {object} responseData - The API response containing agent events
 */
function displayAgentEventsTable(responseData) {
  console.log('\n=== Agent Events Report ===');
  console.log(formatAgentEventsTable(responseData));
  console.log(`\nTotal Events: ${responseData?.data?.length || 0}`);
}

/**
 * Format agent status data into a properly aligned table
 * @param {object} responseData - The API response containing agent status data
 * @returns {string} - Formatted table string
 */
function formatAgentStatusTable(responseData) {
  if (!responseData || !responseData.data || !Array.isArray(responseData.data)) {
    return 'No data available';
  }

  const data = responseData.data;
  
  // Define column headers for agent status
  const headers = {
    extension: 'Ext',
    name: 'Name',
    total_calls: 'Calls',
    answered_calls: 'Answered',
    talked_time: 'Talk Time',
    idle_time: 'Idle Time',
    wrap_up_time: 'Wrap Time',
    hold_time: 'Hold Time',
    not_available_time: 'Not Avail'
  };

  // Calculate column widths based on content
  const columnWidths = {
    extension: Math.max(headers.extension.length, Math.max(...data.map(row => String(row.extension || '').length))),
    name: Math.max(headers.name.length, Math.max(...data.map(row => String(row.name || '').length))),
    total_calls: Math.max(headers.total_calls.length, Math.max(...data.map(row => String(row.total_calls || 0).length))),
    answered_calls: Math.max(headers.answered_calls.length, Math.max(...data.map(row => String(row.answered_calls || 0).length))),
    talked_time: Math.max(headers.talked_time.length, Math.max(...data.map(row => String(row.talked_time || 0).length))),
    idle_time: Math.max(headers.idle_time.length, Math.max(...data.map(row => String(row.idle_time || 0).length))),
    wrap_up_time: Math.max(headers.wrap_up_time.length, Math.max(...data.map(row => String(row.wrap_up_time || 0).length))),
    hold_time: Math.max(headers.hold_time.length, Math.max(...data.map(row => String(row.hold_time || 0).length))),
    not_available_time: Math.max(headers.not_available_time.length, Math.max(...data.map(row => String(row.not_available_time || 0).length)))
  };

  // Helper function to pad strings
  const pad = (str, width) => String(str || '').padEnd(width);

  // Create table header
  const headerRow = `| ${pad(headers.extension, columnWidths.extension)} | ${pad(headers.name, columnWidths.name)} | ${pad(headers.total_calls, columnWidths.total_calls)} | ${pad(headers.answered_calls, columnWidths.answered_calls)} | ${pad(headers.talked_time, columnWidths.talked_time)} | ${pad(headers.idle_time, columnWidths.idle_time)} | ${pad(headers.wrap_up_time, columnWidths.wrap_up_time)} | ${pad(headers.hold_time, columnWidths.hold_time)} | ${pad(headers.not_available_time, columnWidths.not_available_time)} |`;
  
  // Create separator row
  const separatorRow = `|${'-'.repeat(columnWidths.extension + 2)}|${'-'.repeat(columnWidths.name + 2)}|${'-'.repeat(columnWidths.total_calls + 2)}|${'-'.repeat(columnWidths.answered_calls + 2)}|${'-'.repeat(columnWidths.talked_time + 2)}|${'-'.repeat(columnWidths.idle_time + 2)}|${'-'.repeat(columnWidths.wrap_up_time + 2)}|${'-'.repeat(columnWidths.hold_time + 2)}|${'-'.repeat(columnWidths.not_available_time + 2)}|`;

  // Create data rows
  const dataRows = data.map(row => {
    return `| ${pad(row.extension, columnWidths.extension)} | ${pad(row.name, columnWidths.name)} | ${pad(row.total_calls, columnWidths.total_calls)} | ${pad(row.answered_calls, columnWidths.answered_calls)} | ${pad(row.talked_time, columnWidths.talked_time)} | ${pad(row.idle_time, columnWidths.idle_time)} | ${pad(row.wrap_up_time, columnWidths.wrap_up_time)} | ${pad(row.hold_time, columnWidths.hold_time)} | ${pad(row.not_available_time, columnWidths.not_available_time)} |`;
  });

  // Combine all parts
  return [headerRow, separatorRow, ...dataRows].join('\n');
}

/**
 * Display agent status data in a formatted table
 * @param {object} responseData - The API response containing agent status data
 */
function displayAgentStatusTable(responseData) {
  console.log('\n=== Agent Status Report ===');
  console.log(formatAgentStatusTable(responseData));
  console.log(`\nTotal Agents: ${responseData?.data?.length || 0}`);
}

/**
 * Fetch the report, automatically traversing pages until completion.
 * @param {string} acct                         – tenant / account id.
 * @param {object} opts                         – query options.
 * @param {number} opts.startDate               – unix ms start of range.
 * @param {number} opts.endDate                 – unix ms end of range.
 * @param {string} [opts.name]                  – filter by agent name.
 * @param {string} [opts.extension]             – filter by extension.
 * @returns {Promise<object[]>}                 – concatenated rows.
 */
export async function fetchAgentStatus(
  acct,
  { startDate, endDate, name, extension } = {}
) {
  // Get tenant configuration for base_url
  const tenantConfig = getTenantConfig(acct);
  const baseUrl = tenantConfig.base_url;
  const url = `${baseUrl}${process.env.AGENT_STATUS_ENDPOINT || '/api/v2/reports/callcenter/agents/stats'}`;

  retry: for (let attempt = 0, delay = 1_000; attempt < MAX_RETRIES; attempt++, delay *= 2) {
    try {
      const params = {
        startDate: Math.floor(startDate / 1000),
        endDate: Math.floor(endDate / 1000),
        ...(name && { name }),
        ...(extension && { extension })
        // No pagination parameters needed for stats API
      };

      const headers = getApiKeyHeaders(acct);
      console.log('REQ', url, params, {
        'X-Account-ID': headers['X-Account-ID'],
        'X-User-Agent': headers['X-User-Agent'],
        'X-API-Key': '[configured]'
      });

      const { data } = await axios.get(url, {
        params,
        headers,
        httpsAgent
      });

      const ensureExt = r => ({
        extension: r.extension ?? r.ext ?? r.userId ?? r.user_id ?? r.id ?? '',
        registered_time: r.registered_time || 0, // Preserve login time from API
        ...r
      });

      // Stats API returns object keyed by extension (as shown in your example)
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        // Keep object format, preserving extension as key for populate-final-hourly.js
        const records = {};
        Object.entries(data).forEach(([ext, info]) => {
          records[ext] = ensureExt({ extension: ext, ...info });
        });
        console.log(`✅ Stats API returned ${Object.keys(records).length} agent records`);
        return records;
      } else if (Array.isArray(data)) {
        // Handle array format if API sometimes returns this
        const records = data.map(ensureExt);
        console.log(`✅ Stats API returned ${records.length} agent records`);
        return records;
      } else {
        console.error('Unexpected Stats API payload; dumping full response:', JSON.stringify(data, null, 2));
        throw new Error('Unrecognised Stats API response format');
      }
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      console.warn(`Stats API request failed (${err.message}); retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw new Error('All Stats API retry attempts failed');
}

// Export the utility functions for use in other modules
export { formatTimestamp, formatAgentEventsTable, displayAgentEventsTable, formatAgentStatusTable, displayAgentStatusTable, toCsv };


async function cli() {
  const [,, acct, startIso, endIso, outputFile] = process.argv;
  if (!acct || !startIso || !endIso) {
    console.error(`Usage: node -r dotenv/config agentStatus.js <accountId> <startISO> <endISO> [outputFile.{csv|json}]`);
    process.exit(1);
  }

  const startDate = Date.parse(startIso);
  const endDate   = Date.parse(endIso);
  if (Number.isNaN(startDate) || Number.isNaN(endDate)) {
    console.error('Invalid ISO date/time strings.');
    process.exit(1);
  }

  const data = await fetchAgentStatus(acct, { startDate, endDate });

  if (outputFile) {
    await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
    if (outputFile.endsWith('.csv')) {
      await fs.promises.writeFile(outputFile, toCsv(data));
    } else {
      await fs.promises.writeFile(outputFile, JSON.stringify(data, null, 2));
    }
    console.log(`Saved ${data.length} records to ${outputFile}`);
  } else {
    // Display formatted table instead of console.table
    displayAgentStatusTable({ data });
  }
}

// Execute when run directly
if (import.meta.url === process.argv[1] || import.meta.url === `file://${process.argv[1]}`) {
  cli().catch(err => {
    console.error(err.response?.data || err.stack || err.message);
    process.exit(1);
  });
}
