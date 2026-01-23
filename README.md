# SwimLabs Announcer

Multi-location roll sheet management and pool announcement system for SwimLabs swimming schools.

## Features
- Multi-location support (6 locations)
- HTML roll sheet upload and parsing
- Attendance tracking
- Zone management with manager override
- Text-to-speech announcements (Piper TTS)
- Remote access via Tailscale
- SwimLabs cyan UI (v4.5+)

## Version
Current: **v4.5** (Session 2 - UI Polish)

## Locations
- SwimLabs Westchester (SLW) - with announcements
- SwimLabs Xenia (SLX)
- SwimShop Reston (SSR)
- SwimShop McLean (SSM)
- SwimShop Tysons (SST)
- SwimShop Sterling (SSS)

## Tech Stack
- Node.js + Express
- SQLite (better-sqlite3)
- Piper TTS
- Cheerio, PDF-parse

## Installation
See INSTALLATION.md

## Development Roadmap
- [x] v4.0: Multi-location support
- [x] v4.5 Session 1: Foundation (database schema)
- [x] v4.5 Session 2: UI polish (SwimLabs cyan)
- [ ] v4.5 Session 3: Search bar
- [ ] v4.5 Session 4: Color-coded rows
- [ ] v5.0: Admin dashboard
- [ ] v5.0: Absence tracker
- [ ] v5.0: Trial follow-up system
