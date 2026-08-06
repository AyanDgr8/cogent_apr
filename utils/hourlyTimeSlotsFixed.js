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
    
    // Use timestamps as-is without alignment to respect exact requested range
    let currentHourStart = startTimestamp;
    
    while (currentHourStart < endTimestamp) {
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
    // Convert to IST time manually to avoid Intl issues
    const istOffsetMs = (5 * 60 + 30) * 60 * 1000; // +5:30 hours
    
    const startISTDate = new Date(startTime * 1000 + istOffsetMs);
    const endISTDate = new Date(endTime * 1000 + istOffsetMs);
    
    // Format manually to avoid locale issues
    const formatISTDateTime = (date) => {
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
    
    return `${formatISTDateTime(startISTDate)} - ${formatISTDateTime(endISTDate)}`;
}

/**
 * Convert Unix timestamp to IST timezone date string (simplified)
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} Formatted date string
 */
export function timestampToISTDate(timestamp) {
    const istOffsetMs = (5 * 60 + 30) * 60 * 1000; // +5:30 hours
    const istDate = new Date(timestamp * 1000 + istOffsetMs);
    
    const day = istDate.getUTCDate().toString().padStart(2, '0');
    const month = (istDate.getUTCMonth() + 1).toString().padStart(2, '0');
    const year = istDate.getUTCFullYear();
    const hours = istDate.getUTCHours().toString().padStart(2, '0');
    const minutes = istDate.getUTCMinutes().toString().padStart(2, '0');
    const seconds = istDate.getUTCSeconds().toString().padStart(2, '0');
    
    return `${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
}

// Backward compatibility alias
export const timestampToDubaiDate = timestampToISTDate;

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
