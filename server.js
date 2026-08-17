import dotenv from 'dotenv';
dotenv.config();
process.env.TZ = 'Asia/Kolkata';

import express from 'express';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { generateEnhancedAgentReport, fetchAgentEvents } from './agentEvents.js';
import { fetchAgentStatus } from './agentStatus.js';
import { pool } from './database/config.js';
import { 
    processAgentStates, 
    formatCustomStatesForDisplay, 
    getStatesForTimeSlot, 
    processTextFormatStates,
    parseNewCustomStatesFormat
} from './utils/stateProcessor.js';
import { generateHourlyTimeSlots } from './utils/hourlyTimeSlots.js';
import { TENANT_CONFIG, getAllTenants, getTenantConfig } from './tenantConfig.js';

// Match CDR deployment: Node serves HTTP internally and Nginx terminates TLS.
// Do not load the certificates in APR while it is behind the reverse proxy.
const sslOptions = null;

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 9503;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Map to store active progressive queries
const activeQueries = new Map();

// Cleanup expired queries every 30 minutes
setInterval(() => {
    const now = Date.now();
    const expireTime = 30 * 60 * 1000; // 30 minutes
    
    for (const [queryId, queryData] of activeQueries.entries()) {
        if (now - queryData.createdAt > expireTime) {
            activeQueries.delete(queryId);
            console.log(`🧹 Cleaned up expired query: ${queryId}`);
        }
    }
}, 30 * 60 * 1000); // Run every 30 minutes

// Middleware
app.set('trust proxy', 1);
app.use(express.json()); // Add JSON parsing middleware for POST requests
app.use(cookieParser());

const REPORT_PASSWORD = process.env.REPORT_PASSWORD || process.env.Password;
if (!REPORT_PASSWORD) {
    throw new Error('APR report password is not configured. Set REPORT_PASSWORD (or Password) in .env.');
}

const REPORT_ACCESS_COOKIE = 'apr_report_access';
const DEFAULT_REPORT_TENANT = process.env.DEFAULT_TENANT || getAllTenants()[0];
const REPORT_ACCESS_SECRET = crypto
    .createHash('sha256')
    .update(`apr-report:${REPORT_PASSWORD}`)
    .digest('hex');

function passwordMatches(candidate) {
    const expectedHash = crypto.createHash('sha256').update(REPORT_PASSWORD).digest();
    const candidateHash = crypto.createHash('sha256').update(String(candidate || '')).digest();
    return crypto.timingSafeEqual(expectedHash, candidateHash);
}

function hasReportAccess(req) {
    const token = req.cookies?.[REPORT_ACCESS_COOKIE];
    if (!token) return false;

    try {
        const payload = jwt.verify(token, REPORT_ACCESS_SECRET);
        return payload?.scope === 'apr-report';
    } catch {
        return false;
    }
}

app.get('/report-login', (req, res) => {
    if (hasReportAccess(req)) {
        return res.redirect(`/${DEFAULT_REPORT_TENANT}`);
    }
    res.sendFile(path.join(__dirname, 'public', 'report-login.html'));
});

app.get('/report-login-logo', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'uploads', 'logo.webp'));
});

app.post('/api/report-access/login', (req, res) => {
    if (!passwordMatches(req.body?.password)) {
        return res.status(401).json({ success: false, error: 'Invalid password' });
    }

    const token = jwt.sign({ scope: 'apr-report' }, REPORT_ACCESS_SECRET, { expiresIn: '12h' });
    res.cookie(REPORT_ACCESS_COOKIE, token, {
        httpOnly: true,
        secure: req.secure,
        sameSite: 'lax',
        maxAge: 12 * 60 * 60 * 1000
    });
    res.json({ success: true });
});

app.post('/api/report-access/logout', (req, res) => {
    res.clearCookie(REPORT_ACCESS_COOKIE, { httpOnly: true, secure: req.secure, sameSite: 'lax' });
    res.json({ success: true });
});

app.use((req, res, next) => {
    if (hasReportAccess(req)) return next();
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: 'Report password required' });
    }

    res.redirect(`/report-login?returnTo=${encodeURIComponent(`/${DEFAULT_REPORT_TENANT}`)}`);
});

// Tenant-based routing - serve index.html with tenant context
app.get('/:tenant', (req, res, next) => {
    const tenant = req.params.tenant.toLowerCase();
    const validTenants = getAllTenants();
    
    if (validTenants.includes(tenant)) {
        // Serve index.html and inject tenant info
        res.sendFile('public/index.html', { root: '.' });
    } else {
        next(); // Not a valid tenant, continue to static files
    }
});

// Root route - show message to add tenant name
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>APR</title>
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@0.9.4/css/bulma.min.css" />
            <style>
                body { 
                    display: flex; 
                    align-items: center; 
                    justify-content: center; 
                    min-height: 100vh; 
                    background: #f5f5f5; 
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                }
                .message-box {
                    background: white;
                    padding: 3rem;
                    border-radius: 12px;
                    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                    text-align: center;
                    max-width: 600px;
                }
                .message-box h1 {
                    color: #363636;
                    margin-bottom: 1rem;
                    font-size: 1.8rem;
                }
                .message-box p {
                    color: #4a4a4a;
                    font-size: 1.1rem;
                }
            </style>
        </head>
        <body>
            <div class="message-box">
                <h1>📊 Agent Performance Report</h1>
                <p>Please add the tenant name to the URL</p>
            </div>
        </body>
        </html>
    `);
});

app.use(express.static('public'));

// API endpoint to get all configured tenants
app.get('/api/tenants', (req, res) => {
    const tenants = Object.entries(TENANT_CONFIG).map(([key, cfg]) => ({
        key,
        name: cfg.name,
        domain: cfg.domain
    }));
    res.json({ 
        success: true, 
        tenants
    });
});

app.get('/api/enhanced-agent-report', async (req, res) => {
    const { tenant, startDateTime, endDateTime } = req.query;

    if (!tenant || !startDateTime || !endDateTime) {
        return res.status(400).json({ error: 'Missing required query parameters: tenant, startDateTime, endDateTime' });
    }

    try {
        console.log('Raw date parameters from frontend:', { startDateTime, endDateTime });
        
        const startDate = new Date(startDateTime);
        const endDate = new Date(endDateTime);
        
        console.log('Parsed dates:', { 
            startDate: startDate.toISOString(), 
            endDate: endDate.toISOString(),
            startTimestamp: startDate.getTime(),
            endTimestamp: endDate.getTime()
        });

        // Fetch agent status (for stats)
        const agentData = await fetchAgentStatus(tenant, { startDate: startDate.getTime(), endDate: endDate.getTime() });

        // Fetch agent events
        const events = await fetchAgentEvents(tenant, { startDate: Math.floor(startDate.getTime() / 1000), endDate: Math.floor(endDate.getTime() / 1000), filterResults: false });

        // Generate the enhanced report
        const report = await generateEnhancedAgentReport(agentData, startDate, endDate, events);

        res.json(report);
    } catch (error) {
        console.error('Error generating enhanced agent report:', error);
        res.status(500).json({ error: 'Failed to generate report' });
    }
});

// Placeholder row for an hourly slot that has no stored data, so a single-agent
// report still shows every slot in the selected range
function buildEmptySlotRow(slot, agentInfo, queryStart, queryEnd) {
    return {
        _isEmptySlot: true,
        agent_name: agentInfo.agent_name,
        agent_extension: agentInfo.agent_extension,
        time_slot_label: slot.slotLabel,
        start_time: slot.startTime,
        end_time: slot.endTime,
        slot_start_datetime: slot.startDate.toISOString(),
        slot_end_datetime: slot.endDate.toISOString(),
        total_calls: 0,
        answered_calls: 0,
        failed_calls: 0,
        answer_rate_percent: 0,
        aht: '00:00:00',
        login_time: '00:00:00',
        first_login_time: null,
        last_logout_time: null,
        not_available_time: '00:00:00',
        wrap_up_time: '00:00:00',
        hold_time: '00:00:00',
        on_call_time: '00:00:00',
        custom_states: '',
        custom_state_login: '00:00:00',
        custom_state_logoff: '00:00:00',
        custom_state_lunch_break: '00:00:00',
        custom_state_tea_break: '00:00:00',
        custom_state_bio: '00:00:00',
        custom_state_short_break_1: '00:00:00',
        custom_state_short_break_2: '00:00:00',
        custom_state_training: '00:00:00',
        custom_state_chat: '00:00:00',
        custom_state_meeting: '00:00:00',
        custom_state_downtime: '00:00:00',
        custom_state_feedback_session: '00:00:00',
        custom_state_floor_support: '00:00:00',
        custom_state_gallabox: '00:00:00',
        custom_state_lq: '00:00:00',
        custom_state_quality_feedback: '00:00:00',
        custom_state_query_cp: '00:00:00',
        custom_state_query_cx: '00:00:00',
        custom_state_setup: '00:00:00',
        productive_break_time: '00:00:00',
        non_productive_break_time: '00:00:00',
        idle_time: '00:00:00',
        report_start_time: queryStart,
        report_end_time: queryEnd,
        created_at: new Date(),
        first_event_time: null,
        last_event_time: null,
        has_login_in_slot: false,
        has_logout_in_slot: false
    };
}

// Unified API endpoint for final_apr data with custom states (WITH PAGINATION)
app.get('/api/unified-apr-report', async (req, res) => {
    try {
        const { tenant, start, end, agent_name, agent_extension, time_slot, page = 1, limit = 1000 } = req.query;

        const MAX_PAGE_SIZE = 5000;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(Math.max(1, parseInt(limit) || 1000), MAX_PAGE_SIZE);
        const offset = (pageNum - 1) * limitNum;
        
        console.log('📥 Unified APR Report Request:');
        console.log('   tenant:', tenant);
        console.log('   start:', start);
        console.log('   end:', end);
        console.log('   agent_name:', agent_name);
        console.log('   agent_extension:', agent_extension);
        console.log('   time_slot:', time_slot);
        console.log('   📄 Pagination: page', pageNum, 'limit', limitNum, 'offset', offset);

        if (!tenant) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required parameter: tenant' 
            });
        }

        if (!start || !end) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required parameters: start and end timestamps' 
            });
        }
        
        // Use tenant-specific tables
        const tableName = `agent_complete_hourly_${tenant}`;
        const activityTableName = `agent_activity_${tenant}`;
        
        // Get tenant config to build dynamic custom state columns
        const tenantConfig = TENANT_CONFIG[tenant];
        const allStates = [
            ...(tenantConfig?.productive_states || []),
            ...(tenantConfig?.non_productive_states || [])
        ];
        
        // Generate custom state column names dynamically
        const customStateColumns = allStates.map(state => {
            const columnName = `custom_state_${state.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
            return columnName;
        }).join(',\n                ');

        let query = `
            SELECT 
                agent_name,
                agent_extension,
                time_slot_label,
                start_time,
                end_time,
                slot_start_datetime,
                slot_end_datetime,
                total_calls,
                answered_calls,
                failed_calls,
                answer_rate_percent,
                aht,
                login_time,
                first_login_time,
                last_logout_time,
                not_available_time,
                wrap_up_time,
                hold_time,
                on_call_time,
                custom_states,
                ${customStateColumns},
                productive_break_time,
                non_productive_break_time,
                idle_time,
                report_start_time,
                report_end_time,
                created_at
            FROM ${tableName} 
            WHERE start_time >= ? AND end_time <= ?
        `;
        
        // IST timezone for consistent date handling
        const TIMEZONE = 'Asia/Kolkata';
        
        // Debug timestamp conversion
        console.log('Frontend sent start:', start, 'which converts to IST:', new Date(start * 1000).toLocaleString('en-IN', {timeZone: TIMEZONE}));
        console.log('Frontend sent end:', end, 'which converts to IST:', new Date(end * 1000).toLocaleString('en-IN', {timeZone: TIMEZONE}));
        
        // Use timestamps directly since database is already in IST timezone
        const queryStart = parseInt(start);
        const queryEnd = parseInt(end);
        console.log('Using direct timestamps for database query - Start:', queryStart, 'End:', queryEnd);
        
        let queryParams = [queryStart, queryEnd];

        // Add optional filters
        if (agent_name) {
            query += ' AND agent_name LIKE ?';
            queryParams.push(`%${agent_name}%`);
        }

        if (agent_extension) {
            query += ' AND agent_extension LIKE ?';
            queryParams.push(`%${agent_extension}%`);
        }

        query += ' ORDER BY agent_name, start_time';

        let rows;
        let totalRecords;

        if (agent_extension) {
            // When filtering by a single agent extension the report must show every hourly
            // slot, including slots with no stored row. Build the full slot list first and
            // paginate over that, otherwise each page would re-add all the missing slots.
            console.log('🔄 Filling missing hourly slots for agent extension:', agent_extension);

            const [allRows] = await pool.execute(query, queryParams);
            console.log(`📊 Database returned ${allRows.length} rows for extension ${agent_extension}`);

            const allTimeSlots = generateHourlyTimeSlots(queryStart, queryEnd);
            console.log(`📅 Generated ${allTimeSlots.length} time slots`);

            const agentInfo = allRows.length > 0 ? {
                agent_name: allRows[0].agent_name,
                agent_extension: allRows[0].agent_extension
            } : {
                agent_name: 'Unknown Agent',
                agent_extension: agent_extension
            };

            const existingRowsMap = new Map();
            allRows.forEach(row => {
                existingRowsMap.set(row.start_time, row);
            });

            const filledRows = allTimeSlots.map(slot => {
                const existingRow = existingRowsMap.get(slot.startTime);
                return existingRow || buildEmptySlotRow(slot, agentInfo, queryStart, queryEnd);
            });

            totalRecords = filledRows.length;
            rows = filledRows.slice(offset, offset + limitNum);
            console.log(`✅ Filled rows: ${totalRecords} (added ${totalRecords - allRows.length} missing slots)`);
        } else {
            // First, get total count for pagination
            let countQuery = `
                SELECT COUNT(*) as total
                FROM ${tableName}
                WHERE start_time >= ? AND end_time <= ?
            `;

            let countParams = [queryStart, queryEnd];

            if (agent_name) {
                countQuery += ' AND agent_name LIKE ?';
                countParams.push(`%${agent_name}%`);
            }

            const [countResult] = await pool.execute(countQuery, countParams);
            totalRecords = countResult[0].total;

            const pagedQuery = `${query} LIMIT ${limitNum} OFFSET ${offset}`;
            console.log('🔍 Executing query with params:', queryParams);
            [rows] = await pool.execute(pagedQuery, queryParams);
        }

        const totalPages = Math.max(1, Math.ceil(totalRecords / limitNum));
        console.log(`📊 Total records: ${totalRecords}, Total pages: ${totalPages}`);
        console.log(`📊 Returning ${rows.length} rows (page ${pageNum}/${totalPages})`);

        // Debug: Show what time slots we actually got
        const uniqueTimeSlots = [...new Set(rows.map(row => row.time_slot_label))].sort();
        console.log('Found time slots in database:', uniqueTimeSlots);
        console.log('Total records returned:', rows.length);

        // Fetch login/logout event timestamps for ALL rows (not just rows with activity)
        // This ensures we capture login/logout events even when agent didn't do any work
        console.log(`🔍 Processing ${rows.length} rows for login/logout events`);

        const firstEventMap = new Map();
        const lastEventMap = new Map();
        const hasLoginInSlotMap = new Map();
        const hasLogoutInSlotMap = new Map();

        for (const row of rows) {
            // Synthetic rows stand in for slots with no stored data - nothing to look up
            if (row._isEmptySlot) continue;

            const mapKey = `${row.agent_name}_${row.start_time}`;

            try {
                // Check for LOGIN event (agent_reg with enabled=true OR agent_not_avail_state with state='Login')
                const [loginEvents] = await pool.execute(`
                    SELECT event_timestamp FROM ${activityTableName} 
                    WHERE agent_name = ? AND event_timestamp >= ? AND event_timestamp < ?
                      AND event_type = 'agent_not_avail_state' AND JSON_UNQUOTE(JSON_EXTRACT(raw_data, '$.state')) = 'Login'
                    ORDER BY event_timestamp ASC LIMIT 1
                `, [row.agent_name, parseInt(row.start_time), parseInt(row.end_time)]);
                
                console.log(`   Login query for ${row.agent_name} slot ${row.time_slot_label}: found ${loginEvents.length} events`);
                
                if (loginEvents.length > 0) {
                    hasLoginInSlotMap.set(mapKey, true);
                    const loginDate = new Date(loginEvents[0].event_timestamp * 1000);
                    firstEventMap.set(mapKey, loginDate.toLocaleString('en-IN', {
                        timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
                    }));
                    console.log(`   Found login: ${firstEventMap.get(mapKey)}`);
                } else {
                    hasLoginInSlotMap.set(mapKey, false);
                    // Get first custom state event timestamp
                    const [firstEvents] = await pool.execute(`
                        SELECT event_timestamp FROM ${activityTableName} 
                        WHERE agent_name = ? AND event_timestamp >= ? AND event_timestamp < ?
                        ORDER BY event_timestamp ASC LIMIT 1
                    `, [row.agent_name, parseInt(row.start_time), parseInt(row.end_time)]);
                    
                    if (firstEvents.length > 0) {
                        const eventDate = new Date(firstEvents[0].event_timestamp * 1000);
                        firstEventMap.set(mapKey, eventDate.toLocaleString('en-IN', {
                            timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
                            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
                        }));
                    }
                }
                
                // Check for LOGOUT event (agent_not_avail_state with state='none' and enabled=false)
                const [logoutEvents] = await pool.execute(`
                    SELECT event_timestamp FROM ${activityTableName} 
                    WHERE agent_name = ? AND event_timestamp >= ? AND event_timestamp < ?
                      AND event_type = 'agent_not_avail_state' AND JSON_UNQUOTE(JSON_EXTRACT(raw_data, '$.state')) = 'none' AND CAST(JSON_EXTRACT(raw_data, '$.enabled') AS UNSIGNED) = 0
                    ORDER BY event_timestamp DESC LIMIT 1
                `, [row.agent_name, parseInt(row.start_time), parseInt(row.end_time)]);
                
                if (logoutEvents.length > 0) {
                    hasLogoutInSlotMap.set(mapKey, true);
                    const logoutDate = new Date(logoutEvents[0].event_timestamp * 1000);
                    lastEventMap.set(mapKey, logoutDate.toLocaleString('en-IN', {
                        timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
                    }));
                } else {
                    hasLogoutInSlotMap.set(mapKey, false);
                    // Fallback: Use last activity event timestamp if no logout event exists
                    const [lastActivityEvents] = await pool.execute(`
                        SELECT event_timestamp FROM ${activityTableName} 
                        WHERE JSON_UNQUOTE(JSON_EXTRACT(raw_data, '$.ext')) = ? AND event_timestamp >= ? AND event_timestamp < ?
                        ORDER BY event_timestamp DESC LIMIT 1
                    `, [row.agent_extension, parseInt(row.start_time), parseInt(row.end_time)]);
                    
                    if (lastActivityEvents.length > 0) {
                        const lastActivityDate = new Date(lastActivityEvents[0].event_timestamp * 1000);
                        lastEventMap.set(mapKey, lastActivityDate.toLocaleString('en-IN', {
                            timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
                            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
                        }));
                    }
                }
            } catch (err) {
                console.error(`Error fetching events for ${row.agent_name}:`, err.message);
            }
        }

        // Process each row to enhance custom_states with durations
        const enhancedRows = rows.map(row => {
            if (row._isEmptySlot) {
                const { _isEmptySlot, ...emptyRow } = row;
                return emptyRow;
            }

            let enhancedCustomStates = row.custom_states;

            try {
                // Debug: Log the original custom_states data
                // console.log('Original custom_states for row:', row.agent_name, row.time_slot_label, ':', row.custom_states);
                
                // If custom_states contains JSON data, process it
                if (row.custom_states && typeof row.custom_states === 'string') {
                    // Try to parse as JSON first
                    try {
                        const stateData = JSON.parse(row.custom_states);
                        console.log('Parsed JSON data for', row.agent_name, ':', JSON.stringify(stateData, null, 2));
                        
                        // Check if it's an array of state events or object with events property
                        if (Array.isArray(stateData) || (stateData && stateData.events)) {
                            const processedStates = processAgentStates(stateData);
                            console.log('Processed states:', processedStates);
                            
                            // Don't filter by time slot - show all states with their actual timestamps
                            if (processedStates.length > 0) {
                                enhancedCustomStates = formatCustomStatesForDisplay(processedStates);
                                console.log('Enhanced custom states:', enhancedCustomStates);
                            }
                        }
                    } catch (parseError) {
                        // Pass custom states as-is to frontend for proper parsing
                        // The frontend formatCustomStates function will handle the parsing correctly
                        enhancedCustomStates = row.custom_states;
                    }
                }
            } catch (error) {
                console.log('Error processing custom_states for row:', error.message);
                // Keep original custom_states if processing fails
            }
            
            // Add event timestamps and login/logout status
            const mapKey = `${row.agent_name}_${row.start_time}`;
            const firstEventTime = firstEventMap.get(mapKey) || null;
            const lastEventTime = lastEventMap.get(mapKey) || null;
            const hasLoginInSlot = hasLoginInSlotMap.get(mapKey);
            const hasLogoutInSlot = hasLogoutInSlotMap.get(mapKey);
            
            return {
                ...row,
                custom_states: enhancedCustomStates,
                first_event_time: firstEventTime,
                last_event_time: lastEventTime,
                has_login_in_slot: hasLoginInSlot,
                has_logout_in_slot: hasLogoutInSlot
            };
        });

        const finalRows = enhancedRows;

        res.json({
            success: true,
            data: finalRows,
            count: finalRows.length,
            pagination: {
                page: pageNum,
                limit: limitNum,
                totalRecords: totalRecords,
                totalPages: totalPages,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1
            },
            filters: {
                start_timestamp: start,
                end_timestamp: end,
                agent_name: agent_name || null,
                agent_extension: agent_extension || null,
                time_slot: time_slot || null
            }
        });

    } catch (error) {
        console.error('Error fetching unified APR report:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch unified APR report',
            error: error.message 
        });
    }
});

// Legacy API endpoint for APR reports from database (kept for backward compatibility)
app.get('/api/apr-reports', async (req, res) => {
    try {
        const { start, end, type = 'hourly', agent_name, agent_extension, time_slot } = req.query;

        if (!start || !end) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required parameters: start and end timestamps' 
            });
        }

        let query = '';
        let queryParams = [];

        switch (type) {
            case 'hourly':
                query = `
                    SELECT 
                        agent_name,
                        agent_extension,
                        time_slot_label,
                        start_time,
                        end_time,
                        total_calls,
                        answered_calls,
                        failed_calls,
                        aht,
                        login_time,
                        first_login_time,
                        last_logout_time,
                        not_available_time,
                        wrap_up_time,
                        hold_time,
                        on_call_time,
                        custom_states,
                        created_at
                    FROM final_apr 
                    WHERE start_time >= ? AND end_time <= ?
                `;
                queryParams = [start, end];
                break;

            case 'activity':
                query = `
                    SELECT 
                        agent_name,
                        event_timestamp,
                        event_type,
                        event_state,
                        time_slot_label,
                        time_slot_start,
                        time_slot_end,
                        raw_data,
                        created_at
                    FROM ${activityTableName} 
                    WHERE time_slot_start >= ? AND time_slot_end <= ?
                `;
                queryParams = [start, end];
                break;

            case 'summary':
                query = `
                    SELECT 
                        agent_name,
                        agent_extension,
                        COUNT(*) as time_slots_count,
                        SUM(total_calls) as total_calls,
                        SUM(answered_calls) as total_answered,
                        SUM(failed_calls) as total_failed,
                        AVG(total_calls) as avg_calls_per_slot,
                        GROUP_CONCAT(DISTINCT time_slot_label ORDER BY start_time) as time_slots
                    FROM final_apr 
                    WHERE start_time >= ? AND end_time <= ?
                    GROUP BY agent_name, agent_extension
                `;
                queryParams = [start, end];
                break;

            default:
                return res.status(400).json({ 
                    success: false, 
                    message: 'Invalid report type. Use: hourly, activity, or summary' 
                });
        }

        // Add optional filters
        if (agent_name) {
            query += ' AND agent_name LIKE ?';
            queryParams.push(`%${agent_name}%`);
        }

        if (agent_extension) {
            query += ' AND agent_extension LIKE ?';
            queryParams.push(`%${agent_extension}%`);
        }

        if (time_slot && type !== 'summary') {
            query += ' AND time_slot_label LIKE ?';
            queryParams.push(`%${time_slot}%`);
        }

        // Add ordering
        if (type === 'summary') {
            query += ' ORDER BY agent_name';
        } else if (type === 'activity') {
            query += ' ORDER BY agent_name, event_timestamp';
        } else {
            query += ' ORDER BY agent_name, start_time';
        }

        console.log('Executing query:', query);
        console.log('With parameters:', queryParams);

        const [rows] = await pool.execute(query, queryParams);

        res.json({
            success: true,
            data: rows,
            count: rows.length,
            type: type,
            filters: {
                start_timestamp: start,
                end_timestamp: end,
                agent_name: agent_name || null,
                agent_extension: agent_extension || null,
                time_slot: time_slot || null
            }
        });

    } catch (error) {
        console.error('Error fetching APR reports:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch APR reports',
            error: error.message 
        });
    }
});

// Reusable query function for unified APR reports with pagination support
async function queryUnifiedAPRReport(params, countOnly = false) {
    const { start, end, agent_name, agent_extension, time_slot, limit, offset } = params;
    
    // Base query for selecting data
    let query = `
        SELECT ${countOnly ? 'COUNT(*) as total_count' : `
            agent_name,
            agent_extension,
            time_slot_label,
            start_time,
            end_time,
            slot_start_datetime,
            slot_end_datetime,
            total_calls,
            answered_calls,
            failed_calls,
            answer_rate_percent,
            aht,
            login_time,
            first_login_time,
            last_logout_time,
            not_available_time,
            wrap_up_time,
            hold_time,
            on_call_time,
            custom_states,
            custom_state_login,
            custom_state_logoff,
            custom_state_lunch_break,
            custom_state_tea_break,
            custom_state_bio,
            custom_state_short_break_1,
            custom_state_short_break_2,
            custom_state_training,
            custom_state_chat,
            custom_state_meeting,
            custom_state_downtime,
            custom_state_feedback_session,
            custom_state_floor_support,
            custom_state_gallabox,
            custom_state_lq,
            custom_state_quality_feedback,
            custom_state_query_cp,
            custom_state_query_cx,
            custom_state_setup,
            productive_break_time,
            non_productive_break_time,
            idle_time,
            report_start_time,
            report_end_time,
            created_at`}
        FROM agent_complete_hourly 
        WHERE start_time >= ? AND start_time <= ?
    `;
    
    let queryParams = [parseInt(start), parseInt(end)];
    
    // Add optional filters
    if (agent_name) {
        query += ' AND agent_name LIKE ?';
        queryParams.push(`%${agent_name}%`);
    }
    
    if (agent_extension) {
        query += ' AND agent_extension = ?';
        queryParams.push(agent_extension);
    }
    
    if (time_slot) {
        query += ' AND time_slot_label LIKE ?';
        queryParams.push(`%${time_slot}%`);
    }
    
    // Add ordering and pagination for data queries
    if (!countOnly) {
        query += ' ORDER BY agent_name, start_time';
        
        if (limit) {
            console.log('🔍 Pagination - limit:', limit, 'offset:', offset, 'offset type:', typeof offset);
            // For now, just use LIMIT without OFFSET to test if basic pagination works
            query += ' LIMIT ?';
            queryParams.push(parseInt(limit));
            console.log('🔍 Using LIMIT only (OFFSET temporarily disabled)');
        }
    }
    
    console.log('🔍 SQL Query:', query);
    console.log('🔍 Query Params:', queryParams);
    const [rows] = await pool.execute(query, queryParams);
    
    if (countOnly) {
        return { totalCount: rows[0].total_count };
    }
    
    // Fetch login/logout event timestamps for ALL rows (not just rows with activity)
    // This ensures we capture login/logout events even when agent didn't do any work
    console.log(`🔍 Processing ${rows.length} rows for login/logout events`);
    
    const firstEventMap = new Map();
    const lastEventMap = new Map();
    const hasLoginInSlotMap = new Map();
    const hasLogoutInSlotMap = new Map();
    
    if (rows.length > 0) {
        for (const row of rows) {
            const mapKey = `${row.agent_name}_${row.start_time}`;
            
            try {
                // Check for LOGIN event (agent_reg with enabled=true)
                const [loginEvents] = await pool.execute(`
                    SELECT event_timestamp
                    FROM ${activityTableName} 
                    WHERE agent_name = ? 
                      AND event_timestamp >= ?
                      AND event_timestamp < ?
                      AND event_type = 'agent_reg'
                      AND CAST(JSON_EXTRACT(raw_data, '$.enabled') AS UNSIGNED) = 1
                    ORDER BY event_timestamp ASC 
                    LIMIT 1
                `, [row.agent_name, parseInt(row.start_time), parseInt(row.end_time)]);
                
                if (loginEvents.length > 0) {
                    hasLoginInSlotMap.set(mapKey, true);
                    const loginTimestamp = loginEvents[0].event_timestamp;
                    const loginDate = new Date(loginTimestamp * 1000);
                    const formattedLogin = loginDate.toLocaleString('en-IN', {
                        timeZone: 'Asia/Kolkata',
                        day: '2-digit', month: '2-digit', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
                    });
                    firstEventMap.set(mapKey, formattedLogin);
                    console.log(`✅ LOGIN found for ${row.agent_name} slot ${row.start_time}: ${formattedLogin}`);
                } else {
                    hasLoginInSlotMap.set(mapKey, false);
                    // Get first custom state event timestamp
                    const [firstEvents] = await pool.execute(`
                        SELECT event_timestamp FROM ${activityTableName} 
                        WHERE agent_name = ? AND event_timestamp >= ? AND event_timestamp < ?
                        ORDER BY event_timestamp ASC LIMIT 1
                    `, [row.agent_name, parseInt(row.start_time), parseInt(row.end_time)]);
                    
                    if (firstEvents.length > 0) {
                        const eventDate = new Date(firstEvents[0].event_timestamp * 1000);
                        const formattedTime = eventDate.toLocaleString('en-IN', {
                            timeZone: 'Asia/Kolkata',
                            day: '2-digit', month: '2-digit', year: 'numeric',
                            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
                        });
                        firstEventMap.set(mapKey, formattedTime);
                        console.log(`📍 FIRST EVENT for ${row.agent_name} slot ${row.start_time}: ${formattedTime}`);
                    } else {
                        console.log(`❌ NO EVENTS for ${row.agent_name} slot ${row.start_time}`);
                    }
                }
                
                // Check for LOGOUT event (agent_reg with enabled=false)
                const [logoutEvents] = await pool.execute(`
                    SELECT event_timestamp
                    FROM ${activityTableName} 
                    WHERE JSON_UNQUOTE(JSON_EXTRACT(raw_data, '$.ext')) = ? 
                      AND event_timestamp >= ?
                      AND event_timestamp < ?
                      AND event_type = 'agent_reg'
                      AND CAST(JSON_EXTRACT(raw_data, '$.enabled') AS UNSIGNED) = 0
                    ORDER BY event_timestamp DESC 
                    LIMIT 1
                `, [row.agent_extension, parseInt(row.start_time), parseInt(row.end_time)]);
                
                if (logoutEvents.length > 0) {
                    hasLogoutInSlotMap.set(mapKey, true);
                    const logoutTimestamp = logoutEvents[0].event_timestamp;
                    const logoutDate = new Date(logoutTimestamp * 1000);
                    lastEventMap.set(mapKey, logoutDate.toLocaleString('en-IN', {
                        timeZone: 'Asia/Kolkata',
                        day: '2-digit', month: '2-digit', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
                    }));
                } else {
                    hasLogoutInSlotMap.set(mapKey, false);
                    // Fallback: Use last activity event timestamp if no logout event exists
                    const [lastActivityEvents] = await pool.execute(`
                        SELECT event_timestamp
                        FROM ${activityTableName} 
                        WHERE JSON_UNQUOTE(JSON_EXTRACT(raw_data, '$.ext')) = ? 
                          AND event_timestamp >= ?
                          AND event_timestamp < ?
                        ORDER BY event_timestamp DESC 
                        LIMIT 1
                    `, [row.agent_extension, parseInt(row.start_time), parseInt(row.end_time)]);
                    
                    if (lastActivityEvents.length > 0) {
                        const lastActivityTimestamp = lastActivityEvents[0].event_timestamp;
                        const lastActivityDate = new Date(lastActivityTimestamp * 1000);
                        lastEventMap.set(mapKey, lastActivityDate.toLocaleString('en-IN', {
                            timeZone: 'Asia/Kolkata',
                            day: '2-digit', month: '2-digit', year: 'numeric',
                            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
                        }));
                    }
                }
            } catch (err) {
                console.error(`Error fetching events for ${row.agent_name}:`, err.message);
            }
        }
    }
    
    // Process each row to enhance custom_states with durations (same as original logic)
    const enhancedRows = rows.map(row => {  
        let enhancedCustomStates = row.custom_states;
        
        try {
            // If custom_states contains JSON data, process it
            if (row.custom_states && typeof row.custom_states === 'string') {
                // Try to parse as JSON first
                try {
                    const stateData = JSON.parse(row.custom_states);
                    console.log('Parsed JSON data for', row.agent_name, ':', JSON.stringify(stateData, null, 2));
                    
                    enhancedCustomStates = formatCustomStatesForDisplay(stateData);
                } catch (jsonError) {
                    // Not JSON format, process as text
                    console.log('Not JSON format, processing as text:', row.custom_states);
                    enhancedCustomStates = processTextFormatStates(row.custom_states, row.start_time, row.end_time);
                    console.log('Enhanced text format:', enhancedCustomStates);
                }
            }
        } catch (error) {
            console.error('Error processing custom states for', row.agent_name, ':', error.message);
            enhancedCustomStates = row.custom_states; // Fallback to original
        }
        
        // Add event timestamps and login/logout status
        const mapKey = `${row.agent_name}_${row.start_time}`;
        const firstEventTime = firstEventMap.get(mapKey) || null;
        const lastEventTime = lastEventMap.get(mapKey) || null;
        const hasLoginInSlot = hasLoginInSlotMap.get(mapKey);
        const hasLogoutInSlot = hasLogoutInSlotMap.get(mapKey);
        
        return {
            ...row,
            custom_states: enhancedCustomStates,
            first_event_time: firstEventTime,
            last_event_time: lastEventTime,
            has_login_in_slot: hasLoginInSlot,
            has_logout_in_slot: hasLogoutInSlot
        };
    });
    
    return { rows: enhancedRows };
}

// Progressive loading initialization endpoint
app.get('/api/reports/progressive/init', async (req, res) => {
    try {
        const params = req.query;
        console.log('🔍 Progressive init received params:', JSON.stringify(params, null, 2));
        
        // Validate required parameters
        if (!params.start || !params.end) {
            return res.status(400).json({
                success: false,
                error: 'start and end timestamps are required'
            });
        }
        
        // Map progressive loading parameters to unified APR report parameters
        const countParams = { 
            start: params.start, 
            end: params.end,
            agent_name: params.agent_name,
            agent_extension: params.agent_extension,
            time_slot: params.time_slot,
            limit: null, 
            offset: null 
        };
        
        try {
            // Get total count using the same filtering logic
            const result = await queryUnifiedAPRReport(countParams, true); // true for count only
            const totalRecords = result.totalCount || 0;
            
            const pageSize = 1000;
            const totalPages = Math.ceil(totalRecords / pageSize);
            const queryId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);
            
            // Store the search parameters for this query ID
            activeQueries.set(queryId, {
                searchParams: params,
                createdAt: Date.now()
            });
            
            console.log(`✅ Progressive init: ${totalRecords} total records, ${totalPages} pages`);
            
            res.json({
                success: true,
                queryId: queryId,
                totalRecords: totalRecords,
                totalPages: totalPages,
                pageSize: pageSize
            });
        } catch (queryError) {
            console.error('Error in queryUnifiedAPRReport during init:', queryError);
            throw queryError;
        }
    } catch (error) {
        console.error('Error initializing progressive query:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Progressive loading endpoint for faster data fetching
app.get('/api/reports/progressive', async (req, res) => {
    try {
        const { queryId, page = 1 } = req.query;
        
        // Get stored search parameters for this query ID
        const queryData = activeQueries.get(queryId);
        if (!queryData) {
            return res.status(400).json({
                success: false,
                error: 'Query ID not found or expired. Please reinitialize the search.'
            });
        }
        
        const pageSize = 1000; // Fixed page size for consistent performance
        const offset = (page - 1) * pageSize;
        
        console.log(`🔍 Progressive loading page ${page}, offset ${offset}`);
        
        // Use the stored search parameters from the original query with pagination
        const params = {
            start: queryData.searchParams.start,
            end: queryData.searchParams.end,
            agent_name: queryData.searchParams.agent_name,
            agent_extension: queryData.searchParams.agent_extension,
            time_slot: queryData.searchParams.time_slot,
            limit: pageSize,
            offset: offset
        };
        
        const result = await queryUnifiedAPRReport(params, false); // false for data retrieval
        
        res.json({
            success: true,
            data: result.rows || [],
            page: parseInt(page),
            pageSize: pageSize,
            isLastPage: (result.rows || []).length < pageSize,
            totalLoaded: offset + (result.rows || []).length
        });
    } catch (error) {
        console.error('Error in progressive loading:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Fast search endpoints for Agent Name and Extension filters using progressive loading pattern

// Get unique agent names for autocomplete (using agent_complete_hourly table)
app.get('/api/agents/names', async (req, res) => {
    try {
        const { tenant, search } = req.query;
        
        if (!tenant) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required parameter: tenant' 
            });
        }
        
        const tableName = `agent_complete_hourly_${tenant}`;
        
        let query = `
            SELECT DISTINCT agent_name 
            FROM ${tableName} 
            WHERE agent_name IS NOT NULL AND agent_name != ''
        `;
        
        let queryParams = [];
        
        if (search && search.length >= 2) {
            query += ' AND agent_name LIKE ?';
            queryParams.push(`%${search}%`);
        }
        
        query += ' ORDER BY agent_name LIMIT 100';
        
        const [rows] = await pool.execute(query, queryParams);
        
        res.json({
            success: true,
            data: rows.map(row => row.agent_name)
        });
    } catch (error) {
        console.error('Error fetching agent names:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch agent names' 
        });
    }
});

// Get unique agent extensions for autocomplete (using agent_complete_hourly table)
app.get('/api/agents/extensions', async (req, res) => {
    try {
        const { tenant, search } = req.query;
        
        if (!tenant) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required parameter: tenant' 
            });
        }
        
        const tableName = `agent_complete_hourly_${tenant}`;
        
        let query = `
            SELECT DISTINCT agent_extension 
            FROM ${tableName} 
            WHERE agent_extension IS NOT NULL AND agent_extension != ''
        `;
        
        let queryParams = [];
        
        if (search && search.length >= 2) {
            query += ' AND agent_extension LIKE ?';
            queryParams.push(`%${search}%`);
        }
        
        query += ' ORDER BY agent_extension LIMIT 100';
        
        const [rows] = await pool.execute(query, queryParams);
        
        res.json({
            success: true,
            data: rows.map(row => row.agent_extension)
        });
    } catch (error) {
        console.error('Error fetching agent extensions:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch agent extensions' 
        });
    }
});

// Get tenant configuration (custom states, etc.)
app.get('/api/tenant/config', async (req, res) => {
    try {
        const { tenant } = req.query;
        
        if (!tenant) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required parameter: tenant' 
            });
        }
        
        const tenantConfig = TENANT_CONFIG[tenant];
        
        if (!tenantConfig) {
            return res.status(404).json({ 
                success: false, 
                message: `Tenant configuration not found for: ${tenant}` 
            });
        }
        
        // Return only the necessary config for frontend
        res.json({
            success: true,
            data: {
                tenant: tenant,
                productive_states: tenantConfig.productive_states || [],
                non_productive_states: tenantConfig.non_productive_states || []
            }
        });
    } catch (error) {
        console.error('Error fetching tenant config:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch tenant configuration' 
        });
    }
});

// Retained for parity with CDR; sslOptions is null in the Nginx deployment.
const useHTTPS = PUBLIC_URL.startsWith('https://');

if (sslOptions && useHTTPS) {
  const server = https.createServer(sslOptions, app);
  server.listen(PORT, HOST, () => {
    console.log(`🔐 HTTPS server running at ${PUBLIC_URL}`);
    console.log(`🌐 Server accessible on all network interfaces (${HOST}:${PORT})`);
  });
  
  server.on('error', (err) => {
    console.error('❌ HTTPS Server error:', err);
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use. Try a different port.`);
    } else if (err.code === 'EACCES') {
      console.error(`❌ Permission denied. Port ${PORT} might require sudo privileges.`);
    }
    process.exit(1);
  });
} else {
  const server = app.listen(PORT, HOST, () => {
    console.log(`🌐 HTTP server running at ${PUBLIC_URL}`);
    if (!useHTTPS) {
      console.log(`⚠️  Running in HTTP mode (PUBLIC_URL is set to HTTP)`);
    } else {
      console.log(`⚠️  Running in HTTP mode (no SSL certificates found)`);
    }
  });
  
  server.on('error', (err) => {
    console.error('❌ HTTP Server error:', err);
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use. Try a different port.`);
    } else if (err.code === 'EACCES') {
      console.error(`❌ Permission denied. Port ${PORT} might require sudo privileges.`);
    }
    process.exit(1);
  });
}
