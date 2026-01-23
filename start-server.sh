#!/bin/bash
cd /home/swimlabswestchester/swimlabs_announcer
/usr/bin/node server.js &
sleep 2
xdg-open http://localhost:5055
wait
