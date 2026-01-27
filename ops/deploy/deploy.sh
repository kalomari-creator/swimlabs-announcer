#!/bin/bash
# SwimLabs Announcer - One-Command Deployment
# Usage: ./deploy.sh

set -e

echo "════════════════════════════════════════════════════════"
echo "  SwimLabs Announcer v5.0 - One-Command Deploy"
echo "════════════════════════════════════════════════════════"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running from correct directory
if [ ! -f "server.js" ]; then
    echo -e "${RED}❌ Error: Must run from announcer directory${NC}"
    exit 1
fi

# Step 1: Install Node.js if needed
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}📦 Node.js not found. Installing Node.js 20...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
    echo -e "${GREEN}✅ Node.js installed: $(node --version)${NC}"
else
    echo -e "${GREEN}✅ Node.js found: $(node --version)${NC}"
fi

# Step 2: Install npm dependencies
echo ""
echo "📦 Installing npm packages..."
npm install --production
echo -e "${GREEN}✅ Dependencies installed${NC}"

# Step 3: Create empty directories (if not exist)
echo ""
echo "📁 Creating directory structure..."
mkdir -p data tts_out
echo -e "${GREEN}✅ Directories ready${NC}"

# Step 4: Initialize database if needed
echo ""
if [ ! -f "data/app.db" ]; then
    echo "📊 Creating database..."
    sqlite3 data/app.db < database-migration-v5.sql
    echo -e "${GREEN}✅ Database created${NC}"
else
    echo -e "${YELLOW}⚠️  Database exists, skipping creation${NC}"
    read -p "Run migrations anyway? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        sqlite3 data/app.db < database-migration-v5.sql
        echo -e "${GREEN}✅ Migrations applied${NC}"
    fi
fi

# Step 5: Make Piper executable
echo ""
echo "🔧 Setting permissions..."
chmod +x bin/piper/piper 2>/dev/null || echo "Piper binary not found (optional for announcements)"
echo -e "${GREEN}✅ Permissions set${NC}"

# Step 6: Check if systemd service exists
echo ""
if systemctl list-units --type=service | grep -q "swimlabs-announcer"; then
    echo "🔄 Restarting existing service..."
    sudo systemctl restart swimlabs-announcer
    echo -e "${GREEN}✅ Service restarted${NC}"
else
    echo -e "${YELLOW}⚠️  Systemd service not found${NC}"
    read -p "Create systemd service? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # Create service file
        sudo tee /etc/systemd/system/swimlabs-announcer.service > /dev/null << EOF
[Unit]
Description=SwimLabs Announcer
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
        sudo systemctl daemon-reload
        sudo systemctl enable swimlabs-announcer
        sudo systemctl start swimlabs-announcer
        echo -e "${GREEN}✅ Service created and started${NC}"
    else
        echo ""
        echo "To start manually: node server.js"
    fi
fi

# Step 7: Show status
echo ""
echo "════════════════════════════════════════════════════════"
echo -e "${GREEN}  ✅ Deployment Complete!${NC}"
echo "════════════════════════════════════════════════════════"
echo ""

# Get IP address
IP=$(hostname -I | awk '{print $1}')

if systemctl is-active --quiet swimlabs-announcer; then
    echo -e "${GREEN}Server Status: Running ✅${NC}"
    echo ""
    echo "Access at:"
    echo "  Local:  http://localhost:5056"
    echo "  Network: http://$IP:5056"
    echo ""
    echo "Useful commands:"
    echo "  Status:  sudo systemctl status swimlabs-announcer"
    echo "  Stop:    sudo systemctl stop swimlabs-announcer"
    echo "  Restart: sudo systemctl restart swimlabs-announcer"
    echo "  Logs:    sudo journalctl -u swimlabs-announcer -f"
else
    echo -e "${YELLOW}Server not running as service${NC}"
    echo ""
    echo "To start manually:"
    echo "  node server.js"
    echo ""
    echo "Server will run on http://$IP:5056"
fi

echo ""
echo "════════════════════════════════════════════════════════"
