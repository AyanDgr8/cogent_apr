// Hourly Time Slot Generation Utilities
// Generates hourly time slots for agent data population

/**
 * Generate hourly time slots between start and end timestamps
 * @param {number} startTimestamp - Unix timestamp in seconds
 * @param {number} endTimestamp - Unix timestamp in seconds
 * @returns {Array} Array of time slot objects with startTime and endTime
 */
export function generateHourlyTimeSlots(startTimestamp, endTimestamp) {
    const timeSlots = [];
    
    // Align start to the beginning of the hour
    const alignedStart = Math.floor(startTimestamp / 3600) * 3600;
    
    // Align end to the next hour boundary (to include the last partial hour)
    const alignedEnd = Math.ceil(endTimestamp / 3600) * 3600;
    
    let currentHourStart = alignedStart;
    
    while (currentHourStart < alignedEnd) {
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
 * Format time slot label for display
 * @param {number} startTime - Unix timestamp in seconds
 * @param {number} endTime - Unix timestamp in seconds
 * @returns {string} Formatted time slot label
 */
export function formatTimeSlotLabel(startTime, endTime) {
    const startDate = new Date(startTime * 1000);
    const endDate = new Date(endTime * 1000);
    
    // Always include date and time in the format: DD/MM/YYYY, HH:MM AM/PM
    const dateTimeOptions = {
        timeZone: 'Asia/Dubai',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    };
    
    const startDateTimeStr = startDate.toLocaleString('en-GB', dateTimeOptions);
    const endDateTimeStr = endDate.toLocaleString('en-GB', dateTimeOptions);
    
    return `${startDateTimeStr} - ${endDateTimeStr}`;
}

/**
 * Convert Unix timestamp to Dubai timezone date string
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} Formatted date string
 */
export function timestampToDubaiDate(timestamp) {
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

/**
 * Example usage and testing function
 */
export function testHourlyTimeSlots() {
    console.log('🧪 Testing Hourly Time Slot Generation\n');
    
    // Test with the example timestamps from user request
    const startTimestamp = 1761977700; // 01/11/2025, 12:00AM
    const endTimestamp = 1762257600;   // 04/11/2025, 04:00PM
    
    console.log(`Start: ${timestampToDubaiDate(startTimestamp)}`);
    console.log(`End: ${timestampToDubaiDate(endTimestamp)}\n`);
    
    const timeSlots = generateHourlyTimeSlots(startTimestamp, endTimestamp);
    
    console.log(`Generated ${timeSlots.length} hourly time slots:\n`);
    
    timeSlots.slice(0, 10).forEach((slot, index) => {
        console.log(`${index + 1}. ${slot.slotLabel} (${slot.durationMinutes} min)`);
        console.log(`   Start: ${timestampToDubaiDate(slot.startTime)}`);
        console.log(`   End: ${timestampToDubaiDate(slot.endTime)}\n`);
    });
    
    if (timeSlots.length > 10) {
        console.log(`... and ${timeSlots.length - 10} more slots\n`);
        
        // Show last few slots
        console.log('Last few slots:');
        timeSlots.slice(-3).forEach((slot, index) => {
            const actualIndex = timeSlots.length - 3 + index;
            console.log(`${actualIndex + 1}. ${slot.slotLabel} (${slot.durationMinutes} min)`);
        });
    }
    
    return timeSlots;
}

export default {
    generateHourlyTimeSlots,
    formatTimeSlotLabel,
    timestampToDubaiDate,
    isTimestampInSlot,
    findTimeSlotForTimestamp,
    groupDataByTimeSlots,
    testHourlyTimeSlots
};
