# Rally Tripmeter (PWA)

Mobile-first GPS rally tripmeter. No backend. Designed for iPhone 6s (375×667) and sun readability.

## Run locally
Any static web server works. HTTPS is required on mobile for GPS + Wake Lock.

Windows PowerShell:
```
cd c:\GitRepos\RALLYTripMeter
python -m http.server 8080
```

For testing on phone, expose over HTTPS. Options:
- `npx serve` + Cloudflare Tunnel
- `ngrok http 8080`
- GitHub Pages (push repo, enable Pages)

Then open on phone, tap **Share → Add to Home Screen** for full-screen PWA.

## Default PIN
`1234` — changeable in Menu.

## Modes

### RECCE
- Trip A, Trip B count **up** from 0
- Shows GPS speed and local OSM speed limit side-by-side
- RESET button sets trip to 0

### RACE
- Set a stage distance in Menu → **RACE STAGE**
- Trip A, Trip B **count down** to 0
- RESET restores the stage distance
- Trip flashes red when reaching 0

## Features implemented
- GPS speed, avg, max
- Heading, altitude
- Dual independent trips (A, B)
- Calibration factor
- Km / miles toggle (display label)
- Live OSM speed-limit lookup (throttled, 80 m / 15 s)
- Over-limit blinking red alert
- Screen Wake Lock
- Offline via service worker
- PIN login, PIN change, logout
- Trip persistence (localStorage)

## Notes
- Speed limits come from OpenStreetMap Overpass API. Coverage depends on OSM data quality for the area.
- Accuracy: GPS distance uses `watchPosition` with high accuracy. Calibration lets you align with roadbook distance.
- Overpass requests are rate-limited by distance (80 m) and time (15 s) to stay polite.
