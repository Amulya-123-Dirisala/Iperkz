# iPerkz Support Agent

AI-powered customer support chatbot for iPerkz Grocery Delivery with real-time driver tracking.

## Features

- 🤖 **AI Chat Support** - Natural language order tracking and support
- 🚗 **Live Driver Tracking** - Real-time driver location on map
- 📱 **Mobile Ready** - PWA support, responsive design
- 🔒 **Secure** - Rate limiting, session management, CORS protection
- 📡 **Mobile API** - REST API for iOS/Android app integration

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000 in your browser.

## Mobile API (v1)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/session` | POST | Create session token |
| `/api/v1/chat` | POST | Chat with support |
| `/api/v1/orders/:id/track` | GET | Track order details |
| `/api/v1/orders/:id/verify` | POST | Verify order ownership |
| `/api/v1/orders/:id/driver-location` | GET | Live driver location |

## Environment Variables

- `PORT` - Server port (default: 3000)
- `API_SECRET` - API authentication secret

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

## License

MIT
