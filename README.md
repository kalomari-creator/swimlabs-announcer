# SwimLabs Announcer

Multi-location roll sheet management and pool announcement system for SwimLabs swimming schools.

## Features
- Multi-location support (6 locations)
- HTML roll sheet upload and parsing
- Attendance tracking
- Zone management
- Text-to-speech announcements (SwimLabs Westchester only)
- Remote access via Tailscale

## Version
Current: v4.5 (Session 2 - UI Polish)

## Installation
See INSTALLATION.md for setup instructions.

## Tech Stack
- Node.js + Express
- SQLite database
- Piper TTS
- Better-sqlite3, Cheerio, PDF-parse

## Locations
- SwimLabs Westchester (SLW) - with announcements
- SwimLabs Xenia (SLX)
- SwimShop Reston (SSR)
- SwimShop McLean (SSM)
- SwimShop Tysons (SST)
- SwimShop Sterling (SSS)
