# APR System - Setup Guide

## 📋 Overview

This system uses a **dynamic tenant configuration** where all tenant-specific settings (including productive/non-productive time definitions) are centralized in `tenantConfig.js`.

---

## 🗄️ Database Setup

### Step 1: Configure Database Connection

Edit `.env` file with your database credentials:

```bash
# Database Configuration - Local
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=Ayan@1012
DB_NAME=AGENT_REPORTS
DB_PORT=3306
```

### Step 2: Run Database Creation Script

```bash
node APRDatabase.js
```

This will automatically create:

1. **Main Database**: `AGENT_REPORTS`

2. **Shared Table**: `users`

3. **Per-Tenant Tables** (created for each tenant in `tenantConfig.js`):
   - `agent_stats_{tenant}` - Agent statistics with hourly time slots
   - `agent_activity_{tenant}` - Agent activity events with time slot grouping
   - `agent_complete_hourly_{tenant}` - Final hourly reports with productive/non-productive time

**Example**: For tenant `thriveco`, tables created:
- `agent_stats_thriveco`
- `agent_activity_thriveco`
- `agent_complete_hourly_thriveco`

---

## ⚙️ Tenant Configuration

### File: `tenantConfig.js`

This is the **single source of truth** for all tenant settings.

### Structure

```javascript
export const TENANT_CONFIG = {
  tenantkey: {
    // Basic tenant info
    name: 'Display Name',
    base_url: 'https://uc.ocubeservices.com:9443',
    account_id: 'unique_account_id',
    domain: 'tenant_domain',
    
    // Productive time states
    productive_states: [
      'On Call',
      'Wrap Up',
      'Hold',
      'Lunch Break',  // Auto-detected as break
      'Tea Break'     // Auto-detected as break
    ],
    
    // Non-productive time states
    non_productive_states: [
      'Not Available',
      'Idle',
      'Training',
      'Meeting',
      'System Issue'
    ]
  }
};
```

**Note**: Breaks are automatically detected by keywords ('break', 'lunch', 'tea', 'bio', 'meal', 'rest') in state names.

### Current Tenants

```javascript
export const TENANT_CONFIG = {
  thriveco: {
    name: 'Thriveco',
    base_url: 'https://uc.ocubeservices.com:9443',
    account_id: 'd7ae8cb9580399d3707f36b71e870fb6',
    domain: 'thriveco',
    productive_states: ['Training', 'Working', 'On Chat'],
    non_productive_states: ['Break', 'Away', 'Lunch']
  },
  hero: {
    name: 'Hero',
    base_url: 'https://uc.ocubeservices.com:9443',
    account_id: '46160ba119df3f42245b9dfc4eac0045',
    domain: 'hero',
    productive_states: ['On Call', 'Wrap Up', 'Hold', 'Lunch Break', 'Tea Break'],
    non_productive_states: ['Not Available', 'Idle', 'Training', 'Meeting', 'System Issue']
  },
  amity: {
    name: 'Amity',
    base_url: 'https://uc.ocubeservices.com:9443',
    account_id: 'e7cd5c37f025b58788d0a79520baf670',
    domain: 'amity',
    productive_states: ['On Call', 'Wrap Up', 'Hold', 'Lunch Break', 'Tea Break'],
    non_productive_states: ['Not Available', 'Idle', 'Training', 'Meeting', 'System Issue']
  }
};
```

---

## 🎯 Defining Productive & Non-Productive Time

### Where to Define

**File**: `tenantConfig.js`

### Two Simple Categories

#### 1. **productive_states**
States that count as **productive work time**:
- `On Call` - Agent is on a call
- `Wrap Up` - Agent is completing post-call work
- `Hold` - Agent has customer on hold
- `Lunch Break` - Scheduled lunch (auto-detected as break)
- `Tea Break` - Scheduled tea break (auto-detected as break)
- `Training` - Training sessions
- `Working` - General work state
- `On Chat` - Handling chat conversations

#### 2. **non_productive_states**
States that count as **non-productive time**:
- `Not Available` - Agent marked as unavailable
- `Idle` - Agent is idle/waiting
- `Break` - General break time (auto-detected as break)
- `Away` - Away from desk
- `Lunch` - Lunch time (auto-detected as break)
- `Meeting` - Meetings
- `System Issue` - Technical problems

### 🔍 Auto-Detection of Breaks

Break states are **automatically detected** based on keywords in the state name:
- Keywords: `'break'`, `'lunch'`, `'tea'`, `'bio'`, `'meal'`, `'rest'`
- Example: `'Lunch Break'` → automatically classified as a break
- Example: `'Bio Break'` → automatically classified as a break
- No need to manually specify break states!

### How to Modify

**Example**: Add "Coffee Break" as productive for Thriveco:

```javascript
thriveco: {
  // ... other config ...
  productive_states: [
    'Training',
    'Working',
    'On Chat',
    'Coffee Break'  // ← Auto-detected as break (contains 'break')
  ]
}
```

**Example**: Add "Bio Break" as non-productive for Hero:

```javascript
hero: {
  // ... other config ...
  non_productive_states: [
    'Not Available',
    'Idle',
    'Hold',
    'Lunch Break',
    'Tea Break',
    'Training'  // ← Move from non_productive_states
  ],
  non_productive_states: [
    'Not Available',
    'Idle',
    'Meeting',
    'System Issue'  // ← Remove 'Training' from here
  ]
}
```

---

## ➕ Adding a New Tenant

### Step 1: Add to `tenantConfig.js`

```javascript
export const TENANT_CONFIG = {
  // ... existing tenants ...
  
  newtenant: {
    name: 'New Tenant Name',
    base_url: 'https://uc.ocubeservices.com:9443',
    account_id: 'your_account_id_here',
    domain: 'newtenant',
    productive_states: [
      'On Call',
      'Wrap Up',
      'Hold'
    ],
    non_productive_states: [
      'Not Available',
      'Idle'
    ],
    productive_break_states: [
      'Lunch Break'
    ],
    non_productive_break_states: [
      'Training'
    ]
  }
};
```

### Step 2: Create Database Tables

```bash
node APRDatabase.js
```

This automatically creates all required tables for the new tenant.

### Step 3: Restart Application

```bash
npm start
# or
node server.js
```

---

## 📊 How Time Calculation Works

When processing agent activity:

```javascript
import { isProductiveState, isProductiveBreak, isNonProductiveBreak } from './tenantConfig.js';

const tenant = 'thriveco';
let productiveTime = 0;
let nonProductiveTime = 0;
let productiveBreakTime = 0;
let nonProductiveBreakTime = 0;

agentStates.forEach(({ state, duration }) => {
  if (isProductiveBreak(tenant, state)) {
    productiveBreakTime += duration;
  } else if (isNonProductiveBreak(tenant, state)) {
    nonProductiveBreakTime += duration;
  } else if (isProductiveState(tenant, state)) {
    productiveTime += duration;
  } else {
    nonProductiveTime += duration;
  }
});
```

---

## 🔧 Helper Functions

```javascript
import { 
  getTenantConfig,
  getAllTenants,
  isProductiveState,
  isNonProductiveState,
  isProductiveBreak,
  isNonProductiveBreak,
  getTenantTableSuffix
} from './tenantConfig.js';

// Get tenant configuration
const config = getTenantConfig('thriveco');
console.log(config.name); // 'Thriveco'

// List all tenants
const tenants = getAllTenants();
console.log(tenants); // ['thriveco', 'hero', 'amity']

// Check state classification
isProductiveState('thriveco', 'On Call');        // true
isNonProductiveState('thriveco', 'Idle');        // true
isProductiveBreak('thriveco', 'Lunch Break');    // true
isNonProductiveBreak('thriveco', 'Training');    // true

// Get database table suffix
getTenantTableSuffix('thriveco'); // 'thriveco'
```

---

## 📁 Environment Variables

### `.env` File

Contains **only shared/global settings**:

```bash
# API Credentials for all tenants
API_USERNAME=reports@multycomm.com
API_PASSWORD=Reports@123

# Database Configuration
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=Ayan@1012
DB_NAME=AGENT_REPORTS
DB_PORT=3306

# API Endpoints (shared across all tenants)
STATE_HISTORY_ENDPOINT=/api/v2/reports/callcenter/agents/state
AGENT_ACTIVITY_EVENTS_ENDPOINT=/api/v2/reports/callcenter/agents/activity/events

# Server Configuration
PORT=9503
HOST=0.0.0.0
PUBLIC_URL=http://localhost:9503
```

### What NOT to Put in `.env`

- ❌ `BASE_URL` - Each tenant has its own in `tenantConfig.js`
- ❌ `ACCOUNT_ID` - Each tenant has its own in `tenantConfig.js`
- ❌ `TENANT` - No longer needed (selected dynamically)

---

## 🚀 Quick Start

1. **Configure `.env`** with database and API credentials
2. **Edit `tenantConfig.js`** to add/modify tenants and productive states
3. **Run database setup**: `node APRDatabase.js`
4. **Start server**: `node server.js`
5. **Access application**: `http://localhost:9503`

---

## ⚠️ Important Notes

- Tenant keys must be **lowercase** (e.g., `thriveco`, not `ThriveCo`)
- State names are **case-sensitive** (e.g., `On Call` not `on call`)
- Always run `node APRDatabase.js` after modifying `tenantConfig.js`
- Backup database before running database script in production

---

## 🐛 Troubleshooting

**Error: "Unknown tenant"**
→ Check tenant key exists in `TENANT_CONFIG` and is lowercase

**States not classified correctly**
→ Verify state name spelling in `tenantConfig.js` (case-sensitive)

**Database tables not created**
→ Run `node APRDatabase.js` and check database credentials

**Connection errors**
→ Verify `base_url` in `tenantConfig.js` is correct for each tenant

---

## 📝 Example Usage

See `examples/tenantConfigUsage.js` for complete working examples.

```bash
node examples/tenantConfigUsage.js
```

---

*Last Updated: May 25, 2026*
