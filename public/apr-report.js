// Unified APR Report JavaScript for Agent Performance Reports
// Fetches all data from final_apr table in one unified table

// Extract tenant from URL path (e.g., /thriveco -> 'thriveco')
const CURRENT_TENANT = window.location.pathname.split('/')[1] || null;
const REPORT_TIMEZONE = 'Asia/Kolkata';

// Tenant display names mapping - will be populated from API
let TENANT_NAMES = {};

// Helper function to check if a row has any activity
// Checks standard time fields and call counts
function hasActivity(row) {
    const timeFields = ['login_time', 'idle_time', 'on_call_time', 'not_available_time', 'wrap_up_time', 'hold_time'];
    
    // Check if any time field has a non-zero value
    const hasTimeActivity = timeFields.some(field => 
        row[field] && row[field] !== '00:00:00'
    );
    
    // Check if there are any calls
    const hasCallActivity = row.total_calls && row.total_calls > 0;
    
    return hasTimeActivity || hasCallActivity;
}

// Helper function to extract first timestamp from custom_states
function extractFirstCustomStateTimestamp(customStates) {
    if (!customStates) return null;
    
    const customStatesStr = customStates.toString();
    
    // Look for timestamp patterns in custom_states
    // Format 1: "State Name (HH:MM:SS AM/PM to HH:MM:SS AM/PM)" or with date
    // Format 2: Timestamps like "11:21:43 AM" or "24/03/2026, 11:21:43 AM"
    
    // Try to find date+time pattern first: "DD/MM/YYYY, HH:MM:SS AM/PM"
    const dateTimeMatch = customStatesStr.match(/(\d{2}\/\d{2}\/\d{4},?\s*\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM|am|pm)?)/);
    if (dateTimeMatch) {
        return dateTimeMatch[1].trim();
    }
    
    // Try to find time pattern: "HH:MM:SS AM/PM to" (first time in a range)
    const timeRangeMatch = customStatesStr.match(/(\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM|am|pm)?)\s*to/i);
    if (timeRangeMatch) {
        return timeRangeMatch[1].trim();
    }
    
    // Try to find any time pattern: "HH:MM:SS AM/PM"
    const timeMatch = customStatesStr.match(/(\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM|am|pm))/i);
    if (timeMatch) {
        return timeMatch[1].trim();
    }
    
    return null;
}

// Helper function to format first login time
// Uses has_login_in_slot from backend to determine if showing login time or "Already logged in"
function formatFirstLogin(row) {
    // Check if agent has activity
    if (!hasActivity(row)) {
        return 'N/A';
    }
    
    // Check if there was an actual login event in this slot
    if (row.has_login_in_slot === true) {
        // Agent logged in during this slot - show the login time
        return row.first_event_time || row.first_login_time || row.first_login || 'N/A';
    }
    
    // Agent was already logged in - show first custom state timestamp
    if (row.first_event_time) {
        return row.first_event_time;
    }
    
    return 'N/A';
}

// Helper function to properly escape CSV values (handles commas, quotes, newlines)
function escapeCSV(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    // If value contains comma, quote, or newline, wrap in quotes and escape internal quotes
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

// Helper function for CSV export - plain text version
function formatFirstLoginForCSV(row) {
    if (!hasActivity(row)) {
        return '';
    }
    
    // Check if there was an actual login event in this slot
    if (row.has_login_in_slot === true) {
        return row.first_event_time || row.first_login_time || row.first_login || '';
    }
    
    // Agent was already logged in - show timestamp only
    if (row.first_event_time) {
        return row.first_event_time;
    }
    return '';
}

// Helper function to format last logout time
// Pass allRows and currentIndex to determine if this is the last active slot
function formatLastLogout(row, allRows, currentIndex) {
    if (!hasActivity(row)) {
        return 'N/A';
    }
    
    // If there was an actual logout event, show it
    if (row.has_logout_in_slot === true) {
        return row.last_event_time || row.last_logout_time || row.last_logout || 'N/A';
    }
    
    // Check if this is the last slot with activity for this agent
    const isLastActiveSlot = !allRows.slice(currentIndex + 1).some(futureRow => {
        if (futureRow.agent_name !== row.agent_name || futureRow.agent_extension !== row.agent_extension) {
            return false;
        }
        return hasActivity(futureRow);
    });
    
    // If this is the last active slot and we have last_event_time, show it as implicit logout
    if (isLastActiveSlot && row.last_event_time) {
        return row.last_event_time;
    }
    
    // Agent still working in subsequent slots
    return 'N/A';
}

// Helper function for CSV export - last logout
function formatLastLogoutForCSV(row, allRows, currentIndex) {
    if (!hasActivity(row)) {
        return '';
    }
    
    // Only show logout time if there was an actual logout event
    if (row.has_logout_in_slot === true) {
        return row.last_event_time || row.last_logout_time || row.last_logout || '';
    }
    
    // Check if this is the last slot with activity for this agent
    if (allRows && currentIndex !== undefined) {
        const isLastActiveSlot = !allRows.slice(currentIndex + 1).some(futureRow => {
            if (futureRow.agent_name !== row.agent_name || futureRow.agent_extension !== row.agent_extension) {
                return false;
            }
            return hasActivity(futureRow);
        });
        
        // If this is the last active slot and we have last_event_time, show it as implicit logout
        if (isLastActiveSlot && row.last_event_time) {
            return row.last_event_time;
        }
    }
    
    return '';
}

// Fetch available tenants from API
async function loadTenants() {
    try {
        const response = await axios.get('/api/tenants');
        if (response.data && response.data.success) {
            // Build tenant names mapping
            response.data.tenants.forEach(tenant => {
                TENANT_NAMES[tenant.key] = tenant.name;
            });
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error loading tenants:', error);
        return false;
    }
}

document.addEventListener('DOMContentLoaded', async function() {
    const form = document.getElementById('filterForm');
    const fetchBtn = document.getElementById('fetchBtn');
    const loading = document.getElementById('loading');
    const errorBox = document.getElementById('errorBox');
    const stats = document.getElementById('stats');
    const resultTable = document.getElementById('resultTable');
    const csvBtn = document.getElementById('csvBtn');
    const tenantNameEl = document.getElementById('tenantName');

    let currentData = [];

    // Load tenants from API
    const tenantsLoaded = await loadTenants();
    
    if (!tenantsLoaded) {
        if (tenantNameEl) {
            tenantNameEl.textContent = 'Error Loading Tenants';
            tenantNameEl.style.color = 'red';
        }
        showError('Failed to load tenant configuration. Please refresh the page.');
        fetchBtn.disabled = true;
        return;
    }

    // Display tenant name and validate
    if (!CURRENT_TENANT || !TENANT_NAMES[CURRENT_TENANT]) {
        if (tenantNameEl) {
            tenantNameEl.textContent = 'Invalid Tenant';
            tenantNameEl.style.color = 'red';
        }
        showError(`Invalid tenant. Available tenants: ${Object.keys(TENANT_NAMES).join(', ')}`);
        fetchBtn.disabled = true;
        return;
    }
    
    if (tenantNameEl) {
        tenantNameEl.textContent = TENANT_NAMES[CURRENT_TENANT];
    }
    
    // Update page title
    document.title = `APR - ${TENANT_NAMES[CURRENT_TENANT]}`;

    // Form submission handler
    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        await fetchUnifiedAPRData();
    });

    // CSV download handler
    csvBtn.addEventListener('click', function() {
        downloadUnifiedCSV();
    });


    async function fetchUnifiedAPRData() {
        try {
            showLoading(true);
            hideError();
            hideStats();
            
            // Clear previous results
            currentData = [];
            resultTable.innerHTML = '';
            csvBtn.disabled = true;

            // Get form values
            const startDate = document.getElementById('start').value;
            const endDate = document.getElementById('end').value;
            const agentName = document.getElementById('agent_name').value;
            const agentExtension = document.getElementById('agent_extension').value;

            if (!startDate || !endDate) {
                showError('Please select both start and end dates');
                return;
            }

            // datetime-local has no timezone. Always interpret report inputs as IST,
            // regardless of the timezone configured on the viewer's computer.
            const startDateTime = luxon.DateTime.fromISO(startDate, { zone: REPORT_TIMEZONE });
            const endDateTime = luxon.DateTime.fromISO(endDate, { zone: REPORT_TIMEZONE });

            if (!startDateTime.isValid || !endDateTime.isValid) {
                showError('Please enter valid IST start and end dates');
                return;
            }

            const startTimestamp = Math.floor(startDateTime.toSeconds());
            const endTimestamp = Math.floor(endDateTime.toSeconds());
            
            console.log('Using Progressive Loading - Start:', startTimestamp, 'End:', endTimestamp);

            // Initialize progressive loading
            const initParams = new URLSearchParams({
                tenant: CURRENT_TENANT,
                start: startTimestamp,
                end: endTimestamp
            });

            if (agentName) initParams.append('agent_name', agentName);
            if (agentExtension) initParams.append('agent_extension', agentExtension);

            // Use progressive loading approach with unified endpoint for fast results
            console.log('Using progressive loading approach with unified endpoint');
            
            // Show initial progress
            const loadingEl = document.querySelector('.loading-message');
            if (loadingEl) {
                loadingEl.textContent = 'Initializing query...';
            }
            
            // Simulate progressive loading behavior for better UX
            await loadDataWithProgress(initParams);

        } catch (error) {
            console.error('Error fetching unified APR data:', error);
            showError(error.response?.data?.message || error.message || 'Failed to fetch unified APR data');
        } finally {
            showLoading(false);
        }
    }

    async function loadDataWithProgress(params) {
        try {
            // Show progress feedback
            const loadingEl = document.querySelector('.loading-message');
            const statsEl = document.getElementById('stats');
            
            if (loadingEl) loadingEl.textContent = 'Fetching data...';
            if (statsEl) {
                statsEl.textContent = 'Loading records...';
                statsEl.classList.remove('is-hidden');
            }
            
            // Setup table headers immediately
            setupTableHeaders();
            
            // Fetch all data from unified endpoint
            const response = await axios.get(`/api/unified-apr-report?${params.toString()}`);
            
            if (!response.data || !response.data.success) {
                throw new Error(response.data?.message || 'Failed to fetch data');
            }
            
            const allData = response.data.data;
            const totalRecords = allData.length;
            
            console.log(`Loaded ${totalRecords} records, starting progressive display`);
            
            // Progressive rendering for better UX
            await renderDataProgressively(allData, totalRecords);
            
        } catch (error) {
            console.error('Error in loadDataWithProgress:', error);
            throw error;
        }
    }
    
    async function renderDataProgressively(allData, totalRecords) {
        const batchSize = 1000; // Render 1000 records at a time
        let renderedCount = 0;
        
        const loadingEl = document.querySelector('.loading-message');
        const statsEl = document.getElementById('stats');
        
        // Process data in batches for smooth rendering
        for (let i = 0; i < allData.length; i += batchSize) {
            const batch = allData.slice(i, i + batchSize);
            
            // Update progress
            renderedCount += batch.length;
            const percentComplete = Math.round((renderedCount / totalRecords) * 100);
            
            if (loadingEl) {
                loadingEl.textContent = `Rendering: ${renderedCount.toLocaleString()} of ${totalRecords.toLocaleString()} records (${percentComplete}%)`;
            }
            
            if (statsEl) {
                statsEl.textContent = `Loading: ${renderedCount.toLocaleString()} of ${totalRecords.toLocaleString()} records (${percentComplete}%)`;
            }
            
            // Append batch to table - pass allData for logout calculation
            appendTableRows(batch, i, allData);
            
            // Add to current data
            if (i === 0) {
                currentData = [...batch];
            } else {
                currentData.push(...batch);
            }
            
            // Small delay to allow UI updates and prevent freezing
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        // Finalize loading
        finishDataLoading(totalRecords);
    }
    
    function finishDataLoading(totalRecords) {
        const loadingEl = document.querySelector('.loading-message');
        const statsEl = document.getElementById('stats');
        
        // Update final status
        if (statsEl) {
            statsEl.textContent = `Loaded ${totalRecords.toLocaleString()} records successfully`;
            statsEl.classList.remove('is-hidden');
        }
        
        if (loadingEl) {
            loadingEl.textContent = `Completed! Loaded ${totalRecords.toLocaleString()} records`;
        }
        
        // Enable CSV download
        csvBtn.disabled = false;
        
        console.log(`Progressive loading complete: ${totalRecords} records displayed`);
    }

    async function loadDataProgressively(queryId, totalRecords) {
        let page = 1;
        let loadedRecords = 0;
        
        while (loadedRecords < totalRecords) {
            try {
                // Update loading message with progress
                const loadingEl = document.querySelector('.loading-message');
                if (loadingEl) {
                    loadingEl.textContent = `Loading... ${loadedRecords}/${totalRecords} records (${Math.round((loadedRecords/totalRecords)*100)}%)`;
                }

                const response = await axios.get(`/api/reports/progressive?queryId=${queryId}&page=${page}`);
                
                if (!response.data || !response.data.success) {
                    console.error('Progressive loading failed:', response.data?.message);
                    break;
                }

                const { data, hasMore } = response.data;
                
                if (data && data.length > 0) {
                    // Append new data to current dataset
                    currentData.push(...data);
                    
                    // Append rows to table (progressive display)
                    appendTableRows(data, loadedRecords);
                    
                    loadedRecords += data.length;
                    
                    // Update stats in real-time
                    showStats(loadedRecords);
                }

                if (!hasMore) {
                    break;
                }

                page++;
                
                // Small delay to prevent overwhelming the server
                await new Promise(resolve => setTimeout(resolve, 50));

            } catch (error) {
                console.error('Error in progressive loading:', error);
                break;
            }
        }
        
        // Final update
        console.log(`Progressive loading complete: ${currentData.length} records loaded`);
        csvBtn.disabled = false;
        
        // Update final loading message
        const loadingEl = document.querySelector('.loading-message');
        if (loadingEl) {
            loadingEl.textContent = `Completed! Loaded ${currentData.length} records`;
        }
    }

    function setupTableHeaders() {
        const headers = [
            'S.No.', 'Agent Name', 'Extension', 'Time Slot', 'Total Calls', 'Answered Calls', 
            'Failed Calls', 'AHT', 'Login Timestamp', 'Logout Timestamp', 'Login Time','Idle Time',
            'Not Available Time', 'Wrap Up Time', 'Hold Time', 'On Call Time', 
            'Productive Break Time', 'Non-Productive Break Time', 'Custom States'
        ];

        const headerHTML = `
            <thead>
                <tr>
                    ${headers.map(h => `<th>${h}</th>`).join('')}
                </tr>
            </thead>
            <tbody></tbody>
        `;
        
        // Ensure table has proper classes for styling
        resultTable.className = 'table is-fullwidth is-striped is-hoverable unified-table';
        resultTable.innerHTML = headerHTML;
    }

    function appendTableRows(data, startIndex, allData = null) {
        const tbody = resultTable.querySelector('tbody');
        if (!tbody) return;
        
        // Use allData if provided, otherwise use data (for backward compatibility)
        const fullDataset = allData || data;
        
        const rowsHTML = data.map((row, batchIndex) => {
            const serialNo = startIndex + batchIndex + 1;
            // Find the actual index in the full dataset
            const actualIndex = allData ? startIndex + batchIndex : batchIndex;
            
            return `
                <tr>
                    <td>${serialNo}</td>
                    <td>${row.agent_name || 'N/A'}</td>
                    <td>${row.agent_extension || 'N/A'}</td>
                    <td>${row.time_slot_label || row.time_slot || 'N/A'}</td>
                    <td>${row.total_calls || 0}</td>
                    <td>${row.answered_calls || 0}</td>
                    <td>${row.failed_calls || 0}</td>
                    <td>${row.aht || 'N/A'}</td>
                    <td>${formatFirstLogin(row)}</td>
                    <td>${formatLastLogout(row, fullDataset, actualIndex)}</td>
                    <td>${row.login_time || 'N/A'}</td>
                    <td>${row.idle_time || 'N/A'}</td>
                    <td>${row.not_available_time || 'N/A'}</td>
                    <td>${row.wrap_up_time || 'N/A'}</td>
                    <td>${row.hold_time || 'N/A'}</td>
                    <td>${row.on_call_time || 'N/A'}</td>
                    <td>${row.productive_break_time || 'N/A'}</td>
                    <td>${row.non_productive_break_time || 'N/A'}</td>
                    <td class="custom-states-cell">
                        <div class="custom-states-content">
                            ${formatCustomStates(row.custom_states)}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
        
        tbody.insertAdjacentHTML('beforeend', rowsHTML);
    }

    function formatCustomStates(customStates) {
        if (!customStates) return '';
        
        const customStatesStr = customStates.toString();
        
        // Check if it's the new API format: [state_name : duration_seconds]
        if (customStatesStr.includes('[') && customStatesStr.includes(':') && !customStatesStr.includes(' to ')) {
            // Parse format: [state_name : duration_seconds], [state_name : duration_seconds], ...
            const stateMatches = customStatesStr.match(/\[([^:]+)\s*:\s*(\d+)\]/g);
            
            if (stateMatches) {
                return stateMatches.map(match => {
                    const parts = match.slice(1, -1).split(':'); // Remove brackets and split
                    const stateName = parts[0].trim();
                    const durationSeconds = parseInt(parts[1].trim());
                    
                    // Convert duration seconds to HH:MM:SS format
                    const hours = Math.floor(durationSeconds / 3600);
                    const minutes = Math.floor((durationSeconds % 3600) / 60);
                    const seconds = durationSeconds % 60;
                    const formattedDuration = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                    
                    return `
                        <div class="state-box">
                            <span class="state-name">${stateName}</span>
                            <div class="state-duration">Duration: ${formattedDuration}</div>
                        </div>
                    `;
                }).join('');
            }
        }
        
        // Check if it's new format (either comma-separated or single state with "to")
        if (customStatesStr.includes(' to ')) {
            // Split by comma to get individual states
            const states = customStatesStr.split(',').map(s => s.trim()).filter(s => s);
            
            return states.map(state => {
                // Parse format: "State Name (start time to end time)"
                const match = state.match(/^(.+?)\s*\((.+?)\)$/);
                if (match) {
                    const stateName = match[1].trim();
                    const timeRange = match[2].trim();
                    
                    return `
                        <div class="state-box">
                            <span class="state-name">${stateName}</span>
                            <div class="state-duration">${timeRange}</div>
                        </div>
                    `;
                } else {
                    return `
                        <div class="state-box">
                            <span class="state-name">${state}</span>
                        </div>
                    `;
                }
            }).join('');
        } else {
            // Legacy format - split by double newlines
            const states = customStatesStr.split('\n\n').filter(state => state.trim());
            
            return states.map(state => {
                const lines = state.split('\n');
                if (lines.length >= 2) {
                    const stateName = lines[0].trim();
                    const duration = lines.slice(1).join('<br>');
                    
                    return `
                        <div class="state-box">
                            <span class="state-name">${stateName}</span>
                            <div class="state-duration">${duration}</div>
                        </div>
                    `;
                } else {
                    // Fallback for single line states
                    return `
                        <div class="state-box">
                            <span class="state-name">${state.trim()}</span>
                        </div>
                    `;
                }
            }).join('');
        }
    }

    function downloadUnifiedCSV() {
        if (!currentData || currentData.length === 0) {
            showError('No data to download');
            return;
        }

        let csvContent = '';
        
        // Add unified headers including S.No. and custom states
        const headers = [
            'S.No.', 'Agent Name', 'Extension', 'Time Slot', 'Total Calls', 'Answered Calls', 
            'Failed Calls', 'AHT', 'Login Timestamp', 'Logout Timestamp', 'Login Time', 'Idle Time',
            'Not Available Time', 'Wrap Up Time', 'Hold Time', 'On Call Time', 
            'Productive Break Time', 'Non-Productive Break Time', 'Custom States'
        ];
        csvContent += headers.join(',') + '\n';
        
        // Add data rows
        currentData.forEach((row, index) => {
            const csvRow = [
                index + 1,
                escapeCSV(row.agent_name || ''),
                escapeCSV(row.agent_extension || ''),
                escapeCSV(row.time_slot_label || ''),
                row.total_calls || 0,
                row.answered_calls || 0,
                row.failed_calls || 0,
                escapeCSV(row.aht || '00:00:00'),
                escapeCSV(formatFirstLoginForCSV(row)),
                escapeCSV(formatLastLogoutForCSV(row, currentData, index)),
                escapeCSV(row.login_time || '00:00:00'),
                escapeCSV(row.idle_time || '00:00:00'),
                escapeCSV(row.not_available_time || '00:00:00'),
                escapeCSV(row.wrap_up_time || '00:00:00'),
                escapeCSV(row.hold_time || '00:00:00'),
                escapeCSV(row.on_call_time || '00:00:00'),
                escapeCSV(row.productive_break_time || '00:00:00'),
                escapeCSV(row.non_productive_break_time || '00:00:00'),
                escapeCSV(formatCustomStatesForCSV(row.custom_states)),
            ];
            csvContent += csvRow.join(',') + '\n';
        });

        // Generate filename with start and end dates
        const startDate = document.getElementById('start').value;
        const endDate = document.getElementById('end').value;
        
        let filename = 'apr_report';
        if (startDate && endDate) {
            // Convert datetime-local format to readable date format
            const formatDate = (dateTimeStr) => {
                return luxon.DateTime.fromISO(dateTimeStr, { zone: REPORT_TIMEZONE }).toFormat('yyyy-MM-dd');
            };
            
            const startFormatted = formatDate(startDate);
            const endFormatted = formatDate(endDate);
            filename = `apr_report_${startFormatted}_to_${endFormatted}`;
        } else {
            // Fallback to current date if no dates selected
            filename = `apr_report_${luxon.DateTime.now().setZone(REPORT_TIMEZONE).toFormat('yyyy-MM-dd')}`;
        }

        // Download file
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }

    function formatCustomStatesForCSV(customStates) {
        if (!customStates) return '';
        
        const customStatesStr = customStates.toString();
        
        // Check if it's the new API format: [state_name : duration_seconds]
        if (customStatesStr.includes('[') && customStatesStr.includes(':') && !customStatesStr.includes(' to ')) {
            const stateMatches = customStatesStr.match(/\[([^:]+)\s*:\s*(\d+)\]/g);
            
            if (stateMatches) {
                return stateMatches.map(match => {
                    const parts = match.slice(1, -1).split(':');
                    const stateName = parts[0].trim();
                    const durationSeconds = parseInt(parts[1].trim());
                    
                    // Convert to HH:MM:SS format
                    const hours = Math.floor(durationSeconds / 3600);
                    const minutes = Math.floor((durationSeconds % 3600) / 60);
                    const seconds = durationSeconds % 60;
                    const formattedDuration = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                    
                    return `${stateName} (${formattedDuration})`;
                }).join(', ');
            }
        }
        
        // For CSV, convert line breaks to spaces and ensure proper comma separation
        let formatted = customStatesStr
            .replace(/<br>/g, ' ')
            .replace(/\n/g, ' ')
            .replace(/,\s*,/g, ', '); // Clean up any double commas
        
        // Fix cases where multiple time periods are concatenated without commas
        // Look for patterns like "State1 (time1 to time2) State2 (time3 to time4)"
        // and add commas between them
        formatted = formatted.replace(/\)\s+([A-Za-z])/g, '), $1');
        
        // Clean up any extra spaces and ensure single spaces after commas
        formatted = formatted.replace(/\s+/g, ' ').replace(/,\s*/g, ', ').trim();
        
        return formatted;
    }

    function showLoading(show) {
        if (show) {
            loading.classList.remove('is-hidden');
            fetchBtn.disabled = true;
        } else {
            loading.classList.add('is-hidden');
            fetchBtn.disabled = false;
        }
    }

    function showError(message) {
        errorBox.textContent = message;
        errorBox.classList.remove('is-hidden');
    }

    function hideError() {
        errorBox.classList.add('is-hidden');
    }

    function showStats(count) {
        stats.textContent = `Found ${count} records`;
        stats.classList.remove('is-hidden');
    }

    function hideStats() {
        stats.classList.add('is-hidden');
    }

    // Initialize the date inputs to the current calendar day in IST.
    const nowIST = luxon.DateTime.now().setZone(REPORT_TIMEZONE);
    document.getElementById('start').value = nowIST.startOf('day').toFormat("yyyy-MM-dd'T'HH:mm");
    document.getElementById('end').value = nowIST.endOf('day').toFormat("yyyy-MM-dd'T'HH:mm");
});
