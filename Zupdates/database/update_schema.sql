ALTER TABLE agent_complete_hourly
    ADD COLUMN available_time VARCHAR(20) NOT NULL DEFAULT '00:00:00'
    AFTER login_time;
