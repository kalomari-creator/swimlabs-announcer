# Announcer systemd service

## Start on boot (run once)

So the app is running after every reboot:

```bash
sudo cp /home/swimlabs-server/Desktop/announcer/ops/systemd/swimlabs-announcer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable swimlabs-announcer
sudo systemctl start swimlabs-announcer
```

## Allow LAN access (if firewall is on)

If you use UFW and get connection reset from other devices (e.g. Mac at http://192.168.0.75:5055):

```bash
sudo ufw allow 5055/tcp
sudo ufw reload
```

## Useful commands

- **Status:** `systemctl status swimlabs-announcer`
- **Logs:** `journalctl -u swimlabs-announcer -f`
- **Restart:** `sudo systemctl restart swimlabs-announcer`
