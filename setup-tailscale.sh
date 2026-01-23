#!/bin/bash
# SwimLabs Announcer - Tailscale Remote Access Setup

echo "═══════════════════════════════════════════════════════════"
echo "  SwimLabs Announcer - Tailscale Setup"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "This will install Tailscale for secure remote access"
echo "across all your locations."
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Setup cancelled."
    exit 0
fi

# Install Tailscale
echo ""
echo "📦 Installing Tailscale..."
curl -fsSL https://tailscale.com/install.sh | sh

# Start Tailscale
echo ""
echo "🚀 Starting Tailscale..."
echo ""
echo "A browser window will open for authentication."
echo "Sign in with your Google/Microsoft account."
echo ""
sudo tailscale up

# Get Tailscale IP
TAILSCALE_IP=$(tailscale ip -4)

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✅ Tailscale Setup Complete!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Your server's Tailscale IP: $TAILSCALE_IP"
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Install Tailscale on each device (tablet, laptop, etc.):"
echo "   - Android/iOS: Get Tailscale app from store"
echo "   - Windows/Mac: Download from tailscale.com"
echo "   - Sign in with the SAME account"
echo ""
echo "2. Access the server from any device:"
echo "   http://$TAILSCALE_IP:5055"
echo ""
echo "All your locations will be able to access this server"
echo "securely over the internet!"
echo ""
