#!/usr/bin/env node
// query-db.js
// Simple CLI tool to query the agent reports database
//
// Usage: node query-db.js <command> [options]

import dotenv from 'dotenv';
import { testConnection } from './database/config.js';
import {
    getAgentStatsSummary,
    getTopAgentsByCalls,
    getActivitySummaryByEvent,
    getCustomStatesUsage,
    getFinalAPRSummary,
    getBusiestTimeSlots,
    getLoginLogoutPatterns,
    searchAgents,
    getDatabaseStats
} from './database/queries.js';

dotenv.config();

/**
 * Format and display query results
 */
function displayResults(title, results) {
    console.log(`\n📊 ${title}`);
    console.log('='.repeat(title.length + 4));
    
    if (!results || results.length === 0) {
        console.log('No data found.');
        return;
    }
    
    // Display as table
    console.table(results);
}

/**
 * Show database statistics
 */
async function showStats() {
    try {
        const stats = await getDatabaseStats();
        displayResults('Database Statistics', stats);
        
        const agentStats = await getAgentStatsSummary();
        displayResults('Agent Statistics Summary', agentStats);
        
        const aprStats = await getFinalAPRSummary();
        displayResults('Final APR Summary', aprStats);
        
    } catch (error) {
        console.error('❌ Error fetching statistics:', error.message);
    }
}

/**
 * Show top performing agents
 */
async function showTopAgents(limit = 10) {
    try {
        const agents = await getTopAgentsByCalls(limit);
        displayResults(`Top ${limit} Agents by Total Calls`, agents);
    } catch (error) {
        console.error('❌ Error fetching top agents:', error.message);
    }
}

/**
 * Show activity summary
 */
async function showActivity() {
    try {
        const eventSummary = await getActivitySummaryByEvent();
        displayResults('Activity Summary by Event Type', eventSummary);
        
        const customStates = await getCustomStatesUsage();
        displayResults('Custom States Usage', customStates);
        
    } catch (error) {
        console.error('❌ Error fetching activity data:', error.message);
    }
}

/**
 * Show busiest time slots
 */
async function showBusiestSlots(limit = 10) {
    try {
        const slots = await getBusiestTimeSlots(limit);
        displayResults(`Top ${limit} Busiest Time Slots`, slots);
    } catch (error) {
        console.error('❌ Error fetching time slots:', error.message);
    }
}

/**
 * Show login/logout patterns
 */
async function showLoginPatterns() {
    try {
        const patterns = await getLoginLogoutPatterns();
        displayResults('Agent Login/Logout Patterns', patterns);
    } catch (error) {
        console.error('❌ Error fetching login patterns:', error.message);
    }
}

/**
 * Search for agents
 */
async function searchForAgents(searchTerm) {
    try {
        const agents = await searchAgents(searchTerm);
        displayResults(`Search Results for "${searchTerm}"`, agents);
    } catch (error) {
        console.error('❌ Error searching agents:', error.message);
    }
}

/**
 * Show help information
 */
function showHelp() {
    console.log(`
🎯 Agent Reports Database Query Tool

USAGE:
  node query-db.js <command> [options]

COMMANDS:
  stats                    Show database and agent statistics
  top [limit]             Show top performing agents (default: 10)
  activity                Show activity summary and custom states
  slots [limit]           Show busiest time slots (default: 10)
  logins                  Show agent login/logout patterns
  search <term>           Search agents by name or extension
  help                    Show this help message

EXAMPLES:
  node query-db.js stats
  node query-db.js top 5
  node query-db.js search "John"
  node query-db.js slots 15
  node query-db.js activity

ENVIRONMENT VARIABLES:
  DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT
    `);
}

/**
 * Main function
 */
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args[0] === 'help') {
        showHelp();
        return;
    }
    
    // Test database connection first
    console.log('🔍 Testing database connection...');
    const isConnected = await testConnection();
    if (!isConnected) {
        console.error('❌ Cannot connect to database. Please check your .env configuration.');
        process.exit(1);
    }
    
    const command = args[0].toLowerCase();
    
    try {
        switch (command) {
            case 'stats':
                await showStats();
                break;
                
            case 'top':
                const topLimit = parseInt(args[1]) || 10;
                await showTopAgents(topLimit);
                break;
                
            case 'activity':
                await showActivity();
                break;
                
            case 'slots':
                const slotsLimit = parseInt(args[1]) || 10;
                await showBusiestSlots(slotsLimit);
                break;
                
            case 'logins':
                await showLoginPatterns();
                break;
                
            case 'search':
                if (!args[1]) {
                    console.error('❌ Search term required. Usage: node query-db.js search <term>');
                    process.exit(1);
                }
                await searchForAgents(args[1]);
                break;
                
            default:
                console.error(`❌ Unknown command: ${command}`);
                console.log('Run "node query-db.js help" for available commands.');
                process.exit(1);
        }
        
    } catch (error) {
        console.error('💥 Command execution failed:', error.message);
        process.exit(1);
    }
}

// Run the CLI
main().catch(error => {
    console.error('💥 Unexpected error:', error);
    process.exit(1);
});
