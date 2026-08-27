// timeIntervals.js
// Utility functions for creating different time interval types

/**
 * Split a time range into daily intervals (for agent stats API)
 * @param {number} startTimestamp - Unix timestamp in seconds
 * @param {number} endTimestamp - Unix timestamp in seconds
 * @returns {Array} Array of daily intervals
 */
export function createDailyIntervals(startTimestamp, endTimestamp) {
    const intervals = [];
    
    // Validate input timestamps
    if (!startTimestamp || !endTimestamp || isNaN(startTimestamp) || isNaN(endTimestamp)) {
        console.error(`❌ Invalid timestamps: start=${startTimestamp}, end=${endTimestamp}`);
        return intervals;
    }
    
    const startDate = new Date(startTimestamp * 1000);
    const endDate = new Date(endTimestamp * 1000);
    
    // Validate dates
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        console.error(`❌ Invalid dates: start=${startDate}, end=${endDate}`);
        return intervals;
    }
    
    console.log(`📅 Creating daily intervals: ${startDate.toLocaleString()} → ${endDate.toLocaleString()}`);
    
    let currentDate = new Date(startDate);
    currentDate.setHours(0, 0, 0, 0); // Start at midnight
    
    while (currentDate < endDate) {
        let dayStart, dayEnd;
        
        if (currentDate.toDateString() === startDate.toDateString()) {
            // First day: use actual start time
            dayStart = Math.floor(startDate.getTime() / 1000);
        } else {
            // Other days: start at midnight
            dayStart = Math.floor(currentDate.getTime() / 1000);
        }
        
        // Calculate end time for this day
        const nextDay = new Date(currentDate);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0);
        
        if (nextDay > endDate) {
            // Last day: use actual end time
            dayEnd = endTimestamp;
        } else {
            // Other days: end at 11:59:59 PM
            const endOfDay = new Date(currentDate);
            endOfDay.setHours(23, 59, 59, 999);
            dayEnd = Math.floor(endOfDay.getTime() / 1000);
        }
        
        intervals.push({
            type: 'daily',
            date: currentDate.toISOString().split('T')[0],
            startTime: dayStart,
            endTime: dayEnd,
            startDateTime: new Date(dayStart * 1000),
            endDateTime: new Date(dayEnd * 1000)
        });
        
        // Move to next day
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    console.log(`✅ Created ${intervals.length} daily intervals`);
    return intervals;
}

/**
 * Split a time range into hourly intervals (for agent activity events API)
 * @param {number} startTimestamp - Unix timestamp in seconds
 * @param {number} endTimestamp - Unix timestamp in seconds
 * @returns {Array} Array of hourly intervals
 */
export function createHourlyIntervals(startTimestamp, endTimestamp) {
    const intervals = [];
    
    // Validate input timestamps
    if (!startTimestamp || !endTimestamp || isNaN(startTimestamp) || isNaN(endTimestamp)) {
        console.error(`❌ Invalid timestamps: start=${startTimestamp}, end=${endTimestamp}`);
        return intervals;
    }
    
    const startDate = new Date(startTimestamp * 1000);
    const endDate = new Date(endTimestamp * 1000);
    
    // Validate dates
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        console.error(`❌ Invalid dates: start=${startDate}, end=${endDate}`);
        return intervals;
    }
    
    console.log(`⏰ Creating hourly intervals: ${startDate.toLocaleString()} → ${endDate.toLocaleString()}`);
    
    // Start from the exact start time
    let currentTime = new Date(startDate);
    let intervalCount = 0;
    
    while (currentTime < endDate && intervalCount < 1000) { // Safety limit
        // Calculate end time for this hour
        const nextHour = new Date(currentTime);
        nextHour.setHours(nextHour.getHours() + 1);
        nextHour.setMinutes(0, 0, 0); // Round to next hour boundary
        
        let intervalEnd;
        if (nextHour > endDate) {
            // Last interval: use actual end time
            intervalEnd = endTimestamp;
        } else {
            // Regular interval: end at next hour boundary
            intervalEnd = Math.floor(nextHour.getTime() / 1000);
        }
        
        const intervalStart = Math.floor(currentTime.getTime() / 1000);
        
        intervals.push({
            type: 'hourly',
            interval: intervalCount + 1,
            startTime: intervalStart,
            endTime: intervalEnd,
            startDateTime: new Date(intervalStart * 1000),
            endDateTime: new Date(intervalEnd * 1000),
            duration: Math.round((intervalEnd - intervalStart) / 60) // Duration in minutes
        });
        
        console.log(`   Hour ${intervalCount + 1}: ${new Date(intervalStart * 1000).toLocaleString()} → ${new Date(intervalEnd * 1000).toLocaleString()} (${Math.round((intervalEnd - intervalStart) / 60)}m)`);
        
        // Move to next hour
        currentTime = nextHour;
        intervalCount++;
        
        // Break if we've reached the end
        if (intervalEnd >= endTimestamp) {
            break;
        }
    }
    
    console.log(`✅ Created ${intervals.length} hourly intervals`);
    return intervals;
}

/**
 * Format timestamp to readable string
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
 * Test both interval types
 */
export function testIntervals() {
    console.log('🧪 Testing Time Intervals\n');
    
    // Test with your example: 01/11/2025, 12:00AM to 04/11/2025, 04:00PM
    const startTime = Math.floor(new Date('2025-11-01T00:00:00Z').getTime() / 1000);
    const endTime = Math.floor(new Date('2025-11-04T16:00:00Z').getTime() / 1000);
    
    console.log(`📅 Test Range: ${formatTimestamp(startTime)} to ${formatTimestamp(endTime)}\n`);
    
    // Test daily intervals
    console.log('='.repeat(50));
    console.log('📅 DAILY INTERVALS (for Agent Stats API)');
    console.log('='.repeat(50));
    const dailyIntervals = createDailyIntervals(startTime, endTime);
    dailyIntervals.slice(0, 3).forEach((interval, index) => {
        console.log(`${index + 1}. ${interval.date}: ${formatTimestamp(interval.startTime)} → ${formatTimestamp(interval.endTime)}`);
    });
    if (dailyIntervals.length > 3) {
        console.log(`... and ${dailyIntervals.length - 3} more daily intervals`);
    }
    
    // Test hourly intervals (just first few hours)
    console.log('\n' + '='.repeat(50));
    console.log('⏰ HOURLY INTERVALS (for Agent Activity Events API)');
    console.log('='.repeat(50));
    const hourlyIntervals = createHourlyIntervals(startTime, startTime + 3600 * 6); // First 6 hours
    hourlyIntervals.forEach((interval, index) => {
        console.log(`${index + 1}. ${formatTimestamp(interval.startTime)} → ${formatTimestamp(interval.endTime)} (${interval.duration}m)`);
    });
}

export default {
    createDailyIntervals,
    createHourlyIntervals,
    formatTimestamp,
    getDateFromTimestamp,
    testIntervals
};
