#!/bin/bash
# SwimLabs Announcer Auto-Start Setup Script

echo "═══════════════════════════════════════════════════════════"
echo "  SwimLabs Announcer - Auto-Start Setup"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Copy service file
echo "📋 Installing systemd service..."
sudo cp swimlabs-announcer.service /etc/systemd/system/

# Reload systemd
echo "🔄 Reloading systemd..."
sudo systemctl daemon-reload

# Enable service
echo "✅ Enabling auto-start..."
sudo systemctl enable swimlabs-announcer

# Start service
echo "🚀 Starting service..."
sudo systemctl start swimlabs-announcer

# Wait a moment
sleep 2

# Check status
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Status:"
echo "═══════════════════════════════════════════════════════════"
sudo systemctl status swimlabs-announcer --no-pager

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✅ Setup Complete!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "The server will now:"
echo "  ✓ Start automatically on boot"
echo "  ✓ Restart if it crashes"
echo "  ✓ Run in the background"
echo ""
echo "Useful commands:"
echo "  sudo systemctl stop swimlabs-announcer     # Stop"
echo "  sudo systemctl restart swimlabs-announcer  # Restart"
echo "  sudo systemctl status swimlabs-announcer   # Check status"
echo "  sudo journalctl -u swimlabs-announcer -f   # View logs"
echo ""
echo "Server accessible at: http://$(hostname -I | awk '{print $1}'):5055"
echo ""
