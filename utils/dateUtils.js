// dateUtils.js
// Utility functions for date-based time interval splitting

/**
 * Split a time range into daily intervals
 * @param {number} startTimestamp - Unix timestamp in seconds (start of range)
 * @param {number} endTimestamp - Unix timestamp in seconds (end of range)
 * @returns {Array} Array of daily intervals with start/end times
 */
export function splitTimeRangeIntoDailyIntervals(startTimestamp, endTimestamp) {
    const intervals = [];
    
    // Validate input timestamps
    if (!startTimestamp || !endTimestamp || isNaN(startTimestamp) || isNaN(endTimestamp)) {
        console.error(`❌ Invalid timestamps: start=${startTimestamp}, end=${endTimestamp}`);
        return intervals;
    }
    
    // Convert timestamps to Date objects
    const startDate = new Date(startTimestamp * 1000);
    const endDate = new Date(endTimestamp * 1000);
    
    // Validate dates
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        console.error(`❌ Invalid dates: start=${startDate}, end=${endDate}`);
        return intervals;
    }
    
    console.log(`📅 Splitting time range into daily intervals:`);
    console.log(`   Start: ${startDate.toLocaleString()} (${startTimestamp})`);
    console.log(`   End: ${endDate.toLocaleString()} (${endTimestamp})`);
    
    // Start from the beginning of the start date
    let currentDate = new Date(startDate);
    currentDate.setHours(0, 0, 0, 0); // Set to midnight
    
    while (currentDate < endDate) {
        // Calculate start time for this day
        let dayStart, dayEnd;
        
        if (currentDate.toDateString() === startDate.toDateString()) {
            // First day: use the actual start time
            dayStart = Math.floor(startDate.getTime() / 1000);
        } else {
            // Other days: start at midnight
            dayStart = Math.floor(currentDate.getTime() / 1000);
        }
        
        // Calculate end time for this day
        const nextDay = new Date(currentDate);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0); // Next day at midnight
        
        if (nextDay > endDate) {
            // Last day: use the actual end time
            dayEnd = endTimestamp;
        } else {
            // Other days: end at 11:59:59 PM
            const endOfDay = new Date(currentDate);
            endOfDay.setHours(23, 59, 59, 999);
            dayEnd = Math.floor(endOfDay.getTime() / 1000);
        }
        
        // Create interval object
        const interval = {
            date: currentDate.toISOString().split('T')[0], // YYYY-MM-DD format
            startTime: dayStart,
            endTime: dayEnd,
            startDateTime: new Date(dayStart * 1000),
            endDateTime: new Date(dayEnd * 1000)
        };
        
        intervals.push(interval);
        
        console.log(`   📊 Day ${intervals.length}: ${interval.date} (${interval.startDateTime.toLocaleString()} → ${interval.endDateTime.toLocaleString()})`);
        
        // Move to next day
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    console.log(`✅ Created ${intervals.length} daily intervals`);
    return intervals;
}

/**
 * Format timestamp to readable date string
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} Formatted date string
 */
export function formatTimestamp(timestamp) {
    return new Date(timestamp * 1000).toLocaleString();
}

/**
 * Get date string in YYYY-MM-DD format from timestamp
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} Date string in YYYY-MM-DD format
 */
export function getDateFromTimestamp(timestamp) {
    return new Date(timestamp * 1000).toISOString().split('T')[0];
}

/**
 * Parse date string in MM/DD/YYYY format and convert to timestamp
 * @param {string} dateStr - Date string in MM/DD/YYYY format
 * @param {string} timeStr - Time string in HH:MMAM/PM format (optional, defaults to 12:00AM)
 * @returns {number} Unix timestamp in seconds
 */
export function parseDateTimeString(dateStr, timeStr = '12:00AM') {
    // Parse MM/DD/YYYY format
    const [month, day, year] = dateStr.split('/').map(num => parseInt(num));
    
    // Parse HH:MMAM/PM format
    const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})(AM|PM)/i);
    if (!timeMatch) {
        throw new Error(`Invalid time format: ${timeStr}. Expected format: HH:MMAM/PM`);
    }
    
    let [, hours, minutes, ampm] = timeMatch;
    hours = parseInt(hours);
    minutes = parseInt(minutes);
    
    // Convert to 24-hour format
    if (ampm.toUpperCase() === 'PM' && hours !== 12) {
        hours += 12;
    } else if (ampm.toUpperCase() === 'AM' && hours === 12) {
        hours = 0;
    }
    
    // Create date object
    const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
    
    // Convert to Unix timestamp in seconds
    return Math.floor(date.getTime() / 1000);
}

/**
 * Example usage and testing function
 */
export function testDateUtils() {
    console.log('🧪 Testing Date Utilities\n');
    
    // Test case from your example
    const startTime = parseDateTimeString('01/11/2025', '12:00AM');
    const endTime = parseDateTimeString('04/11/2025', '04:00PM');
    
    console.log(`📅 Test Range: ${formatTimestamp(startTime)} to ${formatTimestamp(endTime)}\n`);
    
    const intervals = splitTimeRangeIntoDailyIntervals(startTime, endTime);
    
    console.log('\n📋 Generated Intervals:');
    intervals.forEach((interval, index) => {
        console.log(`${index + 1}. ${interval.date}: ${formatTimestamp(interval.startTime)} → ${formatTimestamp(interval.endTime)}`);
    });
}

export default {
    splitTimeRangeIntoDailyIntervals,
    formatTimestamp,
    getDateFromTimestamp,
    parseDateTimeString,
    testDateUtils
};
