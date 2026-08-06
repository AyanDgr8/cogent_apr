-- Enhanced Agent Reporting Database Schema with Hourly Time Slots
-- Updated for Meydan Agent Performance Reports with hourly-based data population

CREATE DATABASE IF NOT EXISTS agent_reports_meydan;
USE agent_reports_meydan;

-- Table 1: Agent Stats (Enhanced with hourly time slots)
-- Stores agent statistics data from the stats API with hourly granularity
CREATE TABLE IF NOT EXISTS agent_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agent_name VARCHAR(255) NOT NULL,
    agent_extension VARCHAR(10),
    agent_tags JSON,
    raw_data JSON NOT NULL,
    
    -- Hourly time slot columns
    start_time INT NOT NULL COMMENT 'Unix timestamp for slot start time',
    end_time INT NOT NULL COMMENT 'Unix timestamp for slot end time',
    time_slot_label VARCHAR(100) NOT NULL COMMENT 'Human readable time slot (e.g., "12:00 AM - 01:00 AM")',
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Indexes for better performance
    INDEX idx_agent_name (agent_name),
    INDEX idx_start_time (start_time),
    INDEX idx_end_time (end_time),
    INDEX idx_time_slot (start_time, end_time),
    INDEX idx_created_at (created_at),
    
    -- Unique constraint to prevent duplicate entries for same agent extension in same time slot
    UNIQUE KEY unique_agent_time_slot (agent_extension, start_time, end_time)
);


-- Table 2: Agent Activity (Enhanced with hourly time slot association)
-- Stores agent activity events from the events API with time slot grouping
CREATE TABLE IF NOT EXISTS agent_activity (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agent_name VARCHAR(255) NOT NULL,
    event_timestamp INT NOT NULL COMMENT 'Unix timestamp of the event',
    raw_data JSON NOT NULL,
    
    -- Time slot association
    time_slot_start INT NOT NULL COMMENT 'Start time of the hourly slot this event belongs to',
    time_slot_end INT NOT NULL COMMENT 'End time of the hourly slot this event belongs to',
    time_slot_label VARCHAR(100) NOT NULL COMMENT 'Human readable time slot',
    
    -- Event details extracted from raw_data for easier querying
    event_type VARCHAR(50) COMMENT 'Type of event (e.g., "login", "logout", "break")',
    event_state VARCHAR(50) COMMENT 'Agent state (e.g., "Available", "On Call", "Break")',
    
    -- Custom states in new format: [state_name : timestamp], [state_name : timestamp], ...
    custom_states TEXT COMMENT 'Format: [Ticket_B2B : 1762326000], [Break : 1762326300], ...',
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Indexes for better performance
    INDEX idx_agent_name (agent_name),
    INDEX idx_event_timestamp (event_timestamp),
    INDEX idx_time_slot (time_slot_start, time_slot_end),
    INDEX idx_event_type (event_type),
    INDEX idx_event_state (event_state),
    INDEX idx_created_at (created_at),
    
    -- Composite indexes for common queries
    INDEX idx_agent_time (agent_name, event_timestamp),
    INDEX idx_agent_slot (agent_name, time_slot_start, time_slot_end),
    INDEX idx_slot_state (time_slot_start, time_slot_end, event_state),
    
    -- Unique constraint to prevent duplicate activity entries for same agent and event timestamp
    UNIQUE KEY unique_agent_activity (agent_name, event_timestamp)
);

-- Table 3: Agent Complete Hourly (Combined stats and activity data)
-- Stores the processed final report data with all calculated metrics per hourly slot
CREATE TABLE IF NOT EXISTS agent_complete_hourly (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agent_name VARCHAR(255) NOT NULL,
    agent_extension VARCHAR(10) NOT NULL,
    
    -- Hourly time slot information
    start_time INT NOT NULL COMMENT 'Unix timestamp for slot start time',
    end_time INT NOT NULL COMMENT 'Unix timestamp for slot end time',
    time_slot_label VARCHAR(100) NOT NULL COMMENT 'Human readable time slot',
    slot_start_datetime DATETIME COMMENT 'Readable start datetime',
    slot_end_datetime DATETIME COMMENT 'Readable end datetime',
    
    -- Call statistics for this hourly slot
    total_calls INT DEFAULT 0,
    answered_calls INT DEFAULT 0,
    failed_calls INT DEFAULT 0,
    answer_rate_percent DECIMAL(5,2) DEFAULT 0.00,
    aht VARCHAR(20) DEFAULT '00:00:00',
    
    -- Time-based metrics for this hourly slot
    login_time VARCHAR(20) DEFAULT '00:00:00',
    first_login_time VARCHAR(50),
    last_logout_time VARCHAR(50),
    not_available_time VARCHAR(20) DEFAULT '00:00:00',
    wrap_up_time VARCHAR(20) DEFAULT '00:00:00',
    hold_time VARCHAR(20) DEFAULT '00:00:00',
    on_call_time VARCHAR(20) DEFAULT '00:00:00',
    
    -- Custom states in new format: [state_name : timestamp], [state_name : timestamp], ...
    custom_states TEXT COMMENT 'Format: [Ticket_B2B : 1762326000], [Break : 1762326300], ...',
    -- Productive and Non-Productive Break durations
    productive_break_time VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Meeting, training, Ticket_B2B, Ticket_B2C, Chat, Log In, available',
    non_productive_break_time VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Short Break, Bio Break, Lunch Break',
    
    -- Additional time metrics from API
    idle_time VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Idle time from API stats response',
    
    -- Report metadata
    report_start_time INT NOT NULL COMMENT 'Overall report start time',
    report_end_time INT NOT NULL COMMENT 'Overall report end time',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Indexes for better performance
    INDEX idx_agent_extension (agent_extension),
    INDEX idx_agent_name (agent_name),
    INDEX idx_start_time (start_time),
    INDEX idx_end_time (end_time),
    INDEX idx_time_slot (start_time, end_time),
    INDEX idx_report_time (report_start_time, report_end_time),
    INDEX idx_created_at (created_at),
    
    -- Unique constraint for agent per hourly slot
    UNIQUE KEY unique_agent_hourly_slot (agent_extension, start_time, end_time)
);

-- Drop the old unique constraint that uses agent_name
ALTER TABLE agent_stats DROP INDEX unique_agent_time_slot;

-- Add the new unique constraint that uses agent_extension
ALTER TABLE agent_stats ADD UNIQUE KEY unique_agent_time_slot (agent_extension, start_time, end_time);

-- Show table structures for the 3 essential tables
DESCRIBE agent_stats;
DESCRIBE agent_activity;
DESCRIBE agent_complete_hourly;




-- Add individual custom state columns to agent_complete_hourly table
ALTER TABLE agent_complete_hourly 
ADD COLUMN custom_state_login VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Login duration',
ADD COLUMN custom_state_logoff VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Logoff duration',
ADD COLUMN custom_state_lunch_break VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Lunch Break duration',
ADD COLUMN custom_state_tea_break VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Tea Break duration',
ADD COLUMN custom_state_bio VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Bio duration',
ADD COLUMN custom_state_short_break_1 VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - SHORT BREAK 1 duration',
ADD COLUMN custom_state_short_break_2 VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - SHORT BREAK 2 duration',
ADD COLUMN custom_state_training VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Training duration',
ADD COLUMN custom_state_chat VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Chat duration',
ADD COLUMN custom_state_meeting VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Meeting duration',
ADD COLUMN custom_state_downtime VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Downtime duration',
ADD COLUMN custom_state_feedback_session VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Feedback Session duration',
ADD COLUMN custom_state_floor_support VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Floor Support duration',
ADD COLUMN custom_state_gallabox VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Gallabox duration',
ADD COLUMN custom_state_lq VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - LQ duration',
ADD COLUMN custom_state_quality_feedback VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Quality Feedback duration',
ADD COLUMN custom_state_query_cp VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Query CP duration',
ADD COLUMN custom_state_query_cx VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Query CX duration',
ADD COLUMN custom_state_setup VARCHAR(20) DEFAULT '00:00:00' COMMENT 'Custom State - Setup duration';


