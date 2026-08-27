// Fixed Hourly Time Slot Generation Utilities
// More robust version that works across different server environments

/**
 * Generate hourly time slots between start and end timestamps
 * @param {number} startTimestamp - Unix timestamp in seconds
 * @param {number} endTimestamp - Unix timestamp in seconds
 * @returns {Array} Array of time slot objects with startTime and endTime
 */
export function generateHourlyTimeSlots(startTimestamp, endTimestamp) {
    const timeSlots = [];
    
    // Convert to milliseconds for Date operations
    const startMs = startTimestamp * 1000;
    const endMs = endTimestamp * 1000;
    
    // Create Dubai timezone offset (+4 hours = 4 * 60 * 60 * 1000 ms)
    const dubaiOffsetMs = 4 * 60 * 60 * 1000;
    
    // Align start time to hour boundary in Dubai timezone
    const startDubaiMs = startMs + dubaiOffsetMs;
    const alignedStartDubaiMs = Math.floor(startDubaiMs / (60 * 60 * 1000)) * (60 * 60 * 1000);
    const alignedStartTimestamp = Math.floor((alignedStartDubaiMs - dubaiOffsetMs) / 1000);
    
    // Align end time to next hour boundary in Dubai timezone
    const endDubaiMs = endMs + dubaiOffsetMs;
    const alignedEndDubaiMs = Math.ceil(endDubaiMs / (60 * 60 * 1000)) * (60 * 60 * 1000);
    const alignedEndTimestamp = Math.floor((alignedEndDubaiMs - dubaiOffsetMs) / 1000);
    
    let currentHourStart = alignedStartTimestamp;
    
    while (currentHourStart < alignedEndTimestamp) {
        const currentHourEnd = currentHourStart + 3600; // Add 1 hour (3600 seconds)
        
        // Create slot for this full hour
        timeSlots.push({
            startTime: currentHourStart,
            endTime: currentHourEnd,
            startDate: new Date(currentHourStart * 1000),
            endDate: new Date(currentHourEnd * 1000),
            slotLabel: formatTimeSlotLabel(currentHourStart, currentHourEnd),
            durationMinutes: 60 // Always 60 minutes for full hour slots
        });
        
        // Move to the next hour
        currentHourStart = currentHourEnd;
    }
    
    return timeSlots;
}

/**
 * Format time slot label for display (simplified version)
 * @param {number} startTime - Unix timestamp in seconds
 * @param {number} endTime - Unix timestamp in seconds
 * @returns {string} Formatted time slot label
 */
export function formatTimeSlotLabel(startTime, endTime) {
    // Convert to Dubai time manually to avoid Intl issues
    const dubaiOffsetMs = 4 * 60 * 60 * 1000; // +4 hours
    
    const startDubaiDate = new Date(startTime * 1000 + dubaiOffsetMs);
    const endDubaiDate = new Date(endTime * 1000 + dubaiOffsetMs);
    
    // Format manually to avoid locale issues
    const formatDubaiDateTime = (date) => {
        const day = date.getUTCDate().toString().padStart(2, '0');
        const month = date.getUTCMonth() + 1; // getUTCMonth() is 0-indexed
        const monthStr = month.toString().padStart(2, '0');
        const year = date.getUTCFullYear();
        
        let hours = date.getUTCHours();
        const minutes = date.getUTCMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? 'pm' : 'am';
        
        if (hours === 0) hours = 12;
        else if (hours > 12) hours = hours - 12;
        
        const hoursStr = hours.toString().padStart(2, '0');
        
        return `${day}/${monthStr}/${year}, ${hoursStr}:${minutes} ${ampm}`;
    };
    
    return `${formatDubaiDateTime(startDubaiDate)} - ${formatDubaiDateTime(endDubaiDate)}`;
}

/**
 * Convert Unix timestamp to Dubai timezone date string (simplified)
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} Formatted date string
 */
export function timestampToDubaiDate(timestamp) {
    const dubaiOffsetMs = 4 * 60 * 60 * 1000; // +4 hours
    const dubaiDate = new Date(timestamp * 1000 + dubaiOffsetMs);
    
    const day = dubaiDate.getUTCDate().toString().padStart(2, '0');
    const month = (dubaiDate.getUTCMonth() + 1).toString().padStart(2, '0');
    const year = dubaiDate.getUTCFullYear();
    const hours = dubaiDate.getUTCHours().toString().padStart(2, '0');
    const minutes = dubaiDate.getUTCMinutes().toString().padStart(2, '0');
    const seconds = dubaiDate.getUTCSeconds().toString().padStart(2, '0');
    
    return `${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
}

/**
 * Check if a timestamp falls within a time slot
 * @param {number} timestamp - Unix timestamp in seconds
 * @param {Object} timeSlot - Time slot object with startTime and endTime
 * @returns {boolean} True if timestamp is within the time slot
 */
export function isTimestampInSlot(timestamp, timeSlot) {
    return timestamp >= timeSlot.startTime && timestamp < timeSlot.endTime;
}

/**
 * Find the time slot that contains a given timestamp
 * @param {number} timestamp - Unix timestamp in seconds
 * @param {Array} timeSlots - Array of time slot objects
 * @returns {Object|null} Time slot object or null if not found
 */
export function findTimeSlotForTimestamp(timestamp, timeSlots) {
    return timeSlots.find(slot => isTimestampInSlot(timestamp, slot)) || null;
}

/**
 * Group data by time slots
 * @param {Array} dataArray - Array of data objects with timestamp property
 * @param {Array} timeSlots - Array of time slot objects
 * @param {string} timestampField - Name of the timestamp field in data objects
 * @returns {Object} Object with time slot labels as keys and data arrays as values
 */
export function groupDataByTimeSlots(dataArray, timeSlots, timestampField = 'timestamp') {
    const groupedData = {};
    
    // Initialize groups
    timeSlots.forEach(slot => {
        groupedData[slot.slotLabel] = {
            slot: slot,
            data: []
        };
    });
    
    // Group data into time slots
    dataArray.forEach(item => {
        const timestamp = item[timestampField];
        const timeSlot = findTimeSlotForTimestamp(timestamp, timeSlots);
        
        if (timeSlot) {
            groupedData[timeSlot.slotLabel].data.push(item);
        }
    });
    
    return groupedData;
}

export default {
    generateHourlyTimeSlots,
    formatTimeSlotLabel,
    timestampToDubaiDate,
    isTimestampInSlot,
    findTimeSlotForTimestamp,
    groupDataByTimeSlots
};
