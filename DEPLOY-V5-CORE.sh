#!/bin/bash

# SwimLabs Announcer v5.0 CORE - Automated Deployment Script
# This script safely upgrades from v4.0 to v5.0 Core

set -e  # Exit on error

echo "═══════════════════════════════════════════════════════"
echo "  SwimLabs Announcer v5.0 CORE Deployment"
echo "═══════════════════════════════════════════════════════"
echo ""

# Check if we're in the right directory
if [ ! -f "server.js" ] || [ ! -f "index.html" ]; then
    echo "❌ Error: Please run this script from the announcer directory"
    echo "   cd ~/Desktop/announcer && ./DEPLOY-V5-CORE.sh"
    exit 1
fi

echo "📦 Step 1: Creating backup..."
BACKUP_DIR="../announcer-v4-backup-$(date +%Y%m%d-%H%M%S)"
cp -r . "$BACKUP_DIR"
echo "✅ Backup created at: $BACKUP_DIR"
echo ""

echo "📊 Step 2: Running database migration..."
if [ ! -f "database-migration-v5.sql" ]; then
    echo "❌ Error: database-migration-v5.sql not found"
    echo "   Please copy all v5.0 files to this directory first"
    exit 1
fi

sqlite3 data/app.db < database-migration-v5.sql
echo "✅ Database migrated to v5.0 schema"
echo ""

echo "📁 Step 3: Creating config directory..."
mkdir -p config
mkdir -p admin/exports/absence-reports
mkdir -p admin/exports/trial-reports
mkdir -p admin/exports/attendance-reports
mkdir -p admin/logs
mkdir -p admin/archives
echo "✅ Directories created"
echo ""

echo "📝 Step 4: Deploying configuration files..."
if [ -f "instructors.json" ]; then
    cp instructors.json config/
    echo "✅ instructors.json deployed"
else
    echo "⚠️  Warning: instructors.json not found, skipping"
fi

if [ -f "settings.json" ]; then
    cp settings.json config/
    echo "✅ settings.json deployed"
else
    echo "⚠️  Warning: settings.json not found, skipping"
fi
echo ""

echo "🔄 Step 5: Deploying application files..."

# Backup old files
if [ -f "index.html" ]; then
    cp index.html index-v4-backup.html
fi
if [ -f "server.js" ]; then
    cp server.js server-v4-backup.js
fi

# Deploy new files
if [ -f "index-v5-core.html" ]; then
    cp index-v5-core.html index.html
    echo "✅ index.html updated to v5.0"
else
    echo "⚠️  Warning: index-v5-core.html not found"
fi

if [ -f "server-v5-core.js" ]; then
    cp server-v5-core.js server.js
    echo "✅ server.js updated to v5.0"
else
    echo "⚠️  Warning: server-v5-core.js not found"
fi
echo ""

echo "✅ Deployment complete!"
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Next Steps:"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "1. Restart the server:"
echo "   sudo systemctl restart swimlabs-announcer"
echo "   (or manually: node server.js)"
echo ""
echo "2. Test the upgrade:"
echo "   Open http://$(hostname -I | awk '{print $1}'):5055"
echo ""
echo "3. Verify new features:"
echo "   ✓ New SwimLabs cyan UI"
echo "   ✓ Search bar in header"
echo "   ✓ Color-coded roster rows"
echo "   ✓ Icons only show when active"
echo "   ✓ Instructor dropdown in Add Swimmer"
echo ""
echo "4. If something goes wrong:"
echo "   Restore backup: cp -r $BACKUP_DIR/* ."
echo ""
echo "═══════════════════════════════════════════════════════"

