// State Processing Utility for calculating durations between state changes
// Converts timestamps and formats custom states with durations

/**
 * Converts Unix timestamp to dd/mm/yyyy, hh:mm:ss format
 * @param {number} timestamp - Unix timestamp
 * @returns {string} - Formatted date string
 */
function formatTimestamp(timestamp) {
    const date = new Date(timestamp * 1000);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
}

/**
 * Processes agent state events and calculates durations
 * @param {Array|Object} eventsData - Array of agent state events or object with events property
 * @returns {Array} - Processed states with durations
 */
function processAgentStates(eventsData) {
    // Handle both direct array and object with events property
    let events = Array.isArray(eventsData) ? eventsData : eventsData.events || [];
    
    if (!events || events.length === 0) return [];
    
    // Filter and sort events by timestamp - include all state change events
    const stateEvents = events
        .filter(event => 
            (event.event === 'agent_not_avail_state') ||
            (event.event === 'agent_idle' && event.state === 'available')
        )
        .sort((a, b) => a.Timestamp - b.Timestamp);
    
    const processedStates = [];
    
    for (let i = 0; i < stateEvents.length; i++) {
        const currentEvent = stateEvents[i];
        
        // Skip if enabled is false (logout/end marker) OR state is 'none', 'available', or empty
        // These events can still be used as end markers for previous states
        if (currentEvent.enabled === false ||
            !currentEvent.state || 
            currentEvent.state === 'none' || 
            currentEvent.state === 'available' ||
            currentEvent.event === 'agent_idle') continue;
        
        // Find the next event to calculate duration
        let nextEvent = null;
        for (let j = i + 1; j < stateEvents.length; j++) {
            nextEvent = stateEvents[j];
            break;
        }
        
        const startTime = currentEvent.Timestamp;
        const endTime = nextEvent ? nextEvent.Timestamp : null;
        
        const stateInfo = {
            state: currentEvent.state,
            startTimestamp: startTime,
            endTimestamp: endTime,
            startTime: formatTimestamp(startTime),
            endTime: endTime ? formatTimestamp(endTime) : 'Ongoing',
            duration: endTime ? endTime - startTime : null
        };
        
        processedStates.push(stateInfo);
    }
    
    return processedStates;
}

/**
 * Formats processed states for display in custom_states column
 * @param {Array} processedStates - Array of processed state objects
 * @returns {string} - Formatted string for display
 */
function formatCustomStatesForDisplay(processedStates) {
    if (!processedStates || processedStates.length === 0) return '';
    
    return processedStates.map(state => {
        const duration = state.endTime !== 'Ongoing' ? 
            `${state.startTime} to ${state.endTime}` : 
            `${state.startTime} (Ongoing)`;
        
        return `${state.state}\n${duration}`;
    }).join(', ');
}

/**
 * Formats processed states for CSV export (comma-separated)
 * @param {Array} processedStates - Array of processed state objects
 * @returns {string} - Formatted string for CSV
 */
function formatCustomStatesForCSV(processedStates) {
    if (!processedStates || processedStates.length === 0) return '';
    
    return processedStates.map(state => {
        const duration = state.endTime !== 'Ongoing' ? 
            `${state.startTime} to ${state.endTime}` : 
            `${state.startTime} (Ongoing)`;
        
        return `${state.state} ${duration}`;
    }).join(', ');
}

/**
 * Groups states by hourly time slots
 * @param {Array} processedStates - Array of processed state objects
 * @param {number} slotStart - Start timestamp of the hour slot
 * @param {number} slotEnd - End timestamp of the hour slot
 * @returns {Array} - States that fall within the time slot
 */
function getStatesForTimeSlot(processedStates, slotStart, slotEnd) {
    return processedStates.filter(state => {
        // Include state if it starts within the slot or overlaps with the slot
        return (state.startTimestamp >= slotStart && state.startTimestamp < slotEnd) ||
               (state.endTimestamp && state.startTimestamp < slotStart && state.endTimestamp > slotStart);
    });
}

/**
 * Processes existing text format custom states and enhances them
 * @param {string} textStates - Text format like "Ticket_B2B (03:44 PM)"
 * @param {number} slotStart - Start timestamp of the hour slot
 * @param {number} slotEnd - End timestamp of the hour slot
 * @returns {string} - Enhanced format with durations
 */
function processTextFormatStates(customStatesText, slotStart, slotEnd) {
    if (!customStatesText || customStatesText.trim() === '') {
        return '';
    }
    
    // If the text is already in the correct comma-separated format with "to" keywords,
    // return it as-is to preserve comma separation for CSV export
    if (customStatesText.includes(' to ') && customStatesText.includes(',')) {
        return customStatesText;
    }
    
    // Split by comma to handle multiple states
    const states = customStatesText.split(',').map(s => s.trim()).filter(s => s);
    
    // Check if we should preserve comma format (when states already have "to" format)
    const hasToFormat = states.some(state => state.includes(' to '));
    
    const processedStates = states.map((state, index) => {
        const trimmedState = state.trim();
        
        // Extract state name and time range if present
        const match = trimmedState.match(/^(.+?)\s*\((.+?)\)$/);
        if (match) {
            const stateName = match[1].trim();
            const timeRange = match[2].trim();
            
            // Check if time range already contains "to" (new format from backend)
            if (timeRange.includes(' to ')) {
                return `${stateName} (${timeRange})`;
            } else {
                // Legacy format - calculate end time based on next state
                let endTime;
                if (index < states.length - 1) {
                    // Get start time of next state
                    const nextMatch = states[index + 1].trim().match(/^(.+?)\s*\((.+?)\)$/);
                    endTime = nextMatch ? nextMatch[2].trim() : addOneMinute(timeRange);
                } else {
                    // Last state, add 1 minute
                    endTime = addOneMinute(timeRange);
                }
                
                return hasToFormat ? `${stateName} (${timeRange} to ${endTime})` : `${stateName}\n${timeRange} to ${endTime}`;
            }
        } else {
            // If no time format found, return as-is
            return trimmedState;
        }
    });
    
    // Join with commas if we have "to" format, otherwise use line breaks
    return hasToFormat ? processedStates.join(', ') : processedStates.join('\n\n');
}

// Helper function to add one minute to a time string
function addOneMinute(timeStr) {
    try {
        // Parse time like "11:35 AM" or "01:00 PM"
        const [time, period] = timeStr.split(' ');
        const [hours, minutes] = time.split(':').map(Number);
        
        let newMinutes = minutes + 1;
        let newHours = hours;
        let newPeriod = period;
        
        if (newMinutes >= 60) {
            newMinutes = 0;
            newHours += 1;
            
            if (newHours > 12) {
                newHours = 1;
            } else if (newHours === 12 && period === 'AM') {
                newPeriod = 'PM';
            } else if (newHours === 12 && period === 'PM') {
                newPeriod = 'AM';
            }
        }
        
        const formattedHours = newHours.toString().padStart(2, '0');
        const formattedMinutes = newMinutes.toString().padStart(2, '0');
        
        return `${formattedHours}:${formattedMinutes} ${newPeriod}`;
    } catch (error) {
        // If parsing fails, just return original + " (end)"
        return timeStr + " (end)";
    }
}

// Convert custom states to new storage format: [state_name : timestamp], [state_name : timestamp], ...
function convertToNewCustomStatesFormat(statesArray) {
    if (!statesArray || !Array.isArray(statesArray)) {
        return '';
    }
    
    return statesArray.map(state => {
        if (state.stateName && state.timestamp) {
            return `[${state.stateName} : ${state.timestamp}]`;
        }
        return '';
    }).filter(s => s).join(', ');
}

// Parse new custom states format back to readable display
function parseNewCustomStatesFormat(customStatesText) {
    if (!customStatesText || customStatesText.trim() === '') {
        return '';
    }
    
    // Match pattern: [state_name : duration_seconds]
    const stateMatches = customStatesText.match(/\[([^:]+)\s*:\s*(\d+)\]/g);
    
    if (!stateMatches) {
        return customStatesText; // Return as-is if format doesn't match
    }
    
    return stateMatches.map(match => {
        const parts = match.slice(1, -1).split(':'); // Remove brackets and split
        const stateName = parts[0].trim();
        const durationSeconds = parseInt(parts[1].trim());
        
        // Convert duration seconds to HH:MM:SS format
        const hours = Math.floor(durationSeconds / 3600);
        const minutes = Math.floor((durationSeconds % 3600) / 60);
        const seconds = durationSeconds % 60;
        const formattedDuration = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        return `${stateName}\nDuration: ${formattedDuration}`;
    }).join('\n\n');
}

export {
    formatTimestamp,
    processAgentStates,
    formatCustomStatesForDisplay,
    formatCustomStatesForCSV,
    getStatesForTimeSlot,
    processTextFormatStates,
    convertToNewCustomStatesFormat,
    parseNewCustomStatesFormat
};
