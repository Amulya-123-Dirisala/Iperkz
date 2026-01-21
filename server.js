const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const CryptoJS = require('crypto-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Security: API Secret for mobile app authentication
const API_SECRET = process.env.API_SECRET || 'iperkz-mobile-secret-2026';
const API_VERSION = 'v1';

// CORS configuration for mobile apps and web
const corsOptions = {
    origin: [
        'http://localhost:3000',
        'http://localhost:8080',
        'http://localhost:19006', // Expo
        'https://iperkz.com',
        'https://*.iperkz.com',
        'https://portal.iperkz.com',
        'capacitor://localhost', // Capacitor apps
        'ionic://localhost', // Ionic apps
        'http://localhost', // Mobile WebView
        '*' // Allow all for development - restrict in production
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Device-ID', 'X-App-Version', 'X-Platform']
};

// Rate limiting for API protection
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: { success: false, error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

const strictLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute for sensitive endpoints
    message: { success: false, error: 'Rate limit exceeded. Please wait.' }
});

// Middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disable for embedded maps
    crossOriginEmbedderPolicy: false
}));
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Request logging for debugging
app.use((req, res, next) => {
    const platform = req.headers['x-platform'] || 'web';
    const deviceId = req.headers['x-device-id'] || 'unknown';
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Platform: ${platform}, Device: ${deviceId.slice(0, 8)}...`);
    next();
});

// iPerkz API Configuration
const ORDERS_API_URL = 'https://delivery-routes.vercel.app/api/orders-by-criteria';
const DRIVER_LOCATION_API = 'https://delivery-routes.vercel.app/api/driver-location';
const STORE_ID = '25';
const IOS_APP = 'https://apps.apple.com/us/app/iperkz/id1512501611';
const ANDROID_APP = 'https://play.google.com/store/apps/details?id=com.appisoft.perkz';

// Cache for orders
let ordersCache = null;
let lastFetchTime = 0;
const CACHE_DURATION = 30000; // 30 seconds

// Customer verification sessions (phone/email -> verified order IDs)
// Using Map with expiration for security
const customerSessions = new Map();
const SESSION_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

// Normalize phone number for comparison
function normalizePhone(phone) {
    if (!phone) return '';
    return phone.replace(/[^0-9]/g, '').slice(-10); // Last 10 digits
}

// Normalize email for comparison  
function normalizeEmail(email) {
    if (!email) return '';
    return email.toLowerCase().trim();
}

// Normalize name for comparison (handles various formats)
function normalizeName(name) {
    if (!name) return '';
    return name.toLowerCase().trim()
        .replace(/[^a-z\s]/g, '') // Remove non-letters except spaces
        .replace(/\s+/g, ' '); // Normalize multiple spaces
}

// Verify customer owns the order - IMPROVED for better matching
function verifyCustomerOwnership(order, identifier) {
    if (!order || !identifier) return false;
    
    const input = identifier.trim();
    const inputLower = input.toLowerCase();
    
    // Get order data
    const orderPhone = normalizePhone(order.phone);
    const orderEmail = normalizeEmail(order.email);
    const firstName = normalizeName(order.firstName);
    const lastName = normalizeName(order.lastName);
    const fullName = `${firstName} ${lastName}`.trim();
    const inputPhone = normalizePhone(input);
    const inputNormalized = normalizeName(input);
    
    console.log(`[Verification] Checking: "${input}" against order data`);
    console.log(`[Verification] Order - Phone: ${orderPhone}, Email: ${orderEmail}, FirstName: "${firstName}", LastName: "${lastName}"`);
    
    // 1. Check phone match (full number, last 4 digits, or any matching sequence)
    if (orderPhone && inputPhone && inputPhone.length >= 4) {
        if (orderPhone === inputPhone || 
            orderPhone.endsWith(inputPhone) || 
            orderPhone.includes(inputPhone) ||
            inputPhone.endsWith(orderPhone.slice(-4))) {
            console.log(`[Verification] ✓ Phone match`);
            return true;
        }
    }
    
    // 2. Check email match (full email or username part)
    if (orderEmail && inputLower.length >= 3) {
        const emailUsername = orderEmail.split('@')[0];
        if (orderEmail === inputLower || 
            emailUsername === inputLower ||
            orderEmail.includes(inputLower) ||
            inputLower.includes(emailUsername)) {
            console.log(`[Verification] ✓ Email match`);
            return true;
        }
    }
    
    // 3. Check first name match (flexible - contains, starts with, or exact)
    if (firstName && inputNormalized.length >= 2) {
        if (firstName === inputNormalized ||
            firstName.startsWith(inputNormalized) ||
            inputNormalized.startsWith(firstName) ||
            firstName.includes(inputNormalized) ||
            inputNormalized.includes(firstName)) {
            console.log(`[Verification] ✓ First name match`);
            return true;
        }
    }
    
    // 4. Check last name match
    if (lastName && inputNormalized.length >= 2) {
        if (lastName === inputNormalized ||
            lastName.startsWith(inputNormalized) ||
            inputNormalized.startsWith(lastName) ||
            lastName.includes(inputNormalized) ||
            inputNormalized.includes(lastName)) {
            console.log(`[Verification] ✓ Last name match`);
            return true;
        }
    }
    
    // 5. Check full name match
    if (fullName && inputNormalized.length >= 3) {
        if (fullName === inputNormalized ||
            fullName.includes(inputNormalized) ||
            inputNormalized.includes(firstName) ||
            inputNormalized.includes(lastName)) {
            console.log(`[Verification] ✓ Full name match`);
            return true;
        }
    }
    
    console.log(`[Verification] ✗ No match found`);
    return false;
}

// Get date range for API (last 60 days to now + 7 days)
function getDateRange() {
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - 60);
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + 7);
    
    const formatDate = (d) => d.toISOString().split('T')[0];
    return { startDate: formatDate(startDate), endDate: formatDate(endDate) };
}

// Fetch orders from API
async function fetchOrders() {
    const now = Date.now();
    
    if (ordersCache && (now - lastFetchTime) < CACHE_DURATION) {
        console.log(`[API] Returning ${ordersCache.length} cached orders`);
        return ordersCache;
    }
    
    const { startDate, endDate } = getDateRange();
    console.log(`[API] Fetching orders from ${startDate} to ${endDate}`);
    
    try {
        const response = await fetch(ORDERS_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                storeId: STORE_ID,
                startDate: startDate,
                endDate: endDate
            })
        });
        const data = await response.json();
        
        if (data && data.items) {
            ordersCache = data.items;
            lastFetchTime = now;
            console.log(`[API] Fetched ${ordersCache.length} orders successfully`);
            return ordersCache;
        }
    } catch (error) {
        console.error('[API] Error fetching orders:', error.message);
    }
    
    return ordersCache || [];
}

// Fetch driver locations from API
async function fetchDriverLocations() {
    try {
        const response = await fetch(DRIVER_LOCATION_API);
        const data = await response.json();
        
        if (data && data.success && data.locations) {
            console.log(`[API] Fetched ${data.locations.length} driver locations`);
            return data.locations;
        }
    } catch (error) {
        console.error('[API] Error fetching driver locations:', error.message);
    }
    return [];
}

// Find driver by route name
async function findDriverByRoute(routeName) {
    if (!routeName) return null;
    
    const locations = await fetchDriverLocations();
    const cleanRoute = routeName.replace(/"/g, '').toLowerCase();
    
    // Find driver whose name matches the route pattern
    const driver = locations.find(loc => {
        const driverName = (loc.driver_name || '').toLowerCase();
        return driverName.includes(cleanRoute.split('-')[0]) || cleanRoute.includes(driverName.split('-')[0]);
    });
    
    return driver;
}

// Find order by ID
async function findOrderById(orderId) {
    console.log(`[API] Searching for order #${orderId}`);
    const orders = await fetchOrders();
    
    const order = orders.find(o => o.customerOrderId === parseInt(orderId));
    
    if (order) {
        console.log(`[API] Found order #${orderId} - Status: ${order.orderStatus}`);
    } else {
        console.log(`[API] Order #${orderId} not found in ${orders.length} orders`);
    }
    
    return order;
}

// Get route progress - find all orders on the same route and their status
async function getRouteProgress(routeId) {
    if (!routeId || routeId === '""') return null;
    
    const orders = await fetchOrders();
    const routeOrders = orders.filter(o => {
        const associate = o.deliveryAssociate || '';
        return associate.replace(/"/g, '') === routeId.replace(/"/g, '');
    });
    
    if (routeOrders.length === 0) return null;
    
    // Sort by delivery sequence
    routeOrders.sort((a, b) => (a.deliverySeq || 0) - (b.deliverySeq || 0));
    
    // Count delivered vs pending
    const delivered = routeOrders.filter(o => o.orderStatus === 'DELIVERED').length;
    const total = routeOrders.length;
    const pending = total - delivered;
    
    // Find current stop (first non-delivered)
    const currentStop = routeOrders.find(o => o.orderStatus !== 'DELIVERED');
    const currentSeq = currentStop ? currentStop.deliverySeq : total;
    
    // Get last delivered order for driver's last known location
    const lastDelivered = routeOrders.filter(o => o.orderStatus === 'DELIVERED').pop();
    
    return {
        routeId,
        totalStops: total,
        completedStops: delivered,
        pendingStops: pending,
        currentStopSeq: currentSeq,
        currentStopAddress: currentStop ? currentStop.address : null,
        lastDeliveredAddress: lastDelivered ? lastDelivered.address : null,
        progressPercent: Math.round((delivered / total) * 100),
        orders: routeOrders.map(o => ({
            orderId: o.customerOrderId,
            seq: o.deliverySeq,
            status: o.orderStatus,
            address: o.address,
            customerName: `${o.firstName || ''} ${o.lastName || ''}`.trim()
        }))
    };
}

// Format order status
function getStatusDisplay(status) {
    const statusMap = {
        'PLACED': '📦 Order Placed - Being processed',
        'STARTED': '📦 Packing Started - Your order is being packed',
        'COMPLETED': '✅ Ready for Delivery - Your order is packed',
        'OUT_FOR_DELIVERY': '🚚 Out for Delivery - On the way!',
        'DELIVERED': '✅ Delivered - Enjoy your groceries!',
        'CANCELLED': '❌ Cancelled'
    };
    return statusMap[status] || `Status: ${status}`;
}

// Get status progress step (1-5)
function getStatusStep(status) {
    const steps = {
        'PLACED': 1,
        'STARTED': 2,
        'COMPLETED': 3,
        'OUT_FOR_DELIVERY': 4,
        'DELIVERED': 5,
        'CANCELLED': 0
    };
    return steps[status] || 1;
}

// Generate progress timeline
function getProgressTimeline(status) {
    const step = getStatusStep(status);
    if (status === 'CANCELLED') {
        return `❌ Order Cancelled`;
    }
    
    const stages = [
        { name: 'Order Placed', icon: '📝' },
        { name: 'Packing', icon: '📦' },
        { name: 'Ready', icon: '✅' },
        { name: 'Out for Delivery', icon: '🚚' },
        { name: 'Delivered', icon: '🏠' }
    ];
    
    let timeline = '**Order Progress:**\n';
    stages.forEach((stage, index) => {
        const stageNum = index + 1;
        if (stageNum < step) {
            timeline += `✅ ${stage.name}\n`;
        } else if (stageNum === step) {
            timeline += `➡️ **${stage.name}** ⬅️ Current\n`;
        } else {
            timeline += `⬜ ${stage.name}\n`;
        }
    });
    
    return timeline;
}

// Generate Google Maps URL for address
function getGoogleMapsUrl(address) {
    if (!address) return null;
    const encoded = encodeURIComponent(address);
    return `https://www.google.com/maps/search/?api=1&query=${encoded}`;
}

// Generate Google Maps directions URL from store to customer
function getDirectionsUrl(storeAddress, customerAddress) {
    if (!storeAddress || !customerAddress) return null;
    const origin = encodeURIComponent(storeAddress);
    const dest = encodeURIComponent(customerAddress);
    return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=driving`;
}

// Estimate delivery time based on sequence and status
async function getDeliveryEstimate(order, driverInfo) {
    const deliverySeq = order.deliverySeq || 1;
    const status = order.orderStatus;
    
    // Average time per delivery stop (in minutes)
    const avgTimePerStop = 12;
    
    if (status === 'DELIVERED') {
        return { 
            eta: 'Delivered',
            stopsAway: 0,
            estimatedMinutes: 0,
            message: '✅ Your order has been delivered!',
            routeProgress: null
        };
    }
    
    if (status === 'CANCELLED') {
        return {
            eta: 'Cancelled',
            stopsAway: 0,
            estimatedMinutes: 0,
            message: '❌ This order was cancelled.',
            routeProgress: null
        };
    }
    
    if (status === 'PLACED') {
        return {
            eta: 'Pending',
            stopsAway: null,
            estimatedMinutes: null,
            message: '⏳ Your order is being processed. Delivery time will be available once packing starts.',
            routeProgress: null
        };
    }
    
    if (status === 'STARTED') {
        return {
            eta: 'Packing',
            stopsAway: null,
            estimatedMinutes: null,
            message: '📦 Your order is being packed. Delivery estimate available after driver assignment.',
            routeProgress: null
        };
    }
    
    // Get live route progress for COMPLETED and OUT_FOR_DELIVERY
    let routeProgress = null;
    let stopsAway = deliverySeq;
    
    if (driverInfo && driverInfo.route) {
        routeProgress = await getRouteProgress(driverInfo.route);
        if (routeProgress) {
            // Calculate actual stops away based on completed deliveries
            stopsAway = deliverySeq - routeProgress.completedStops;
            if (stopsAway < 0) stopsAway = 0;
        }
    }
    
    if (status === 'COMPLETED') {
        return {
            eta: 'Ready for pickup',
            stopsAway: stopsAway,
            estimatedMinutes: stopsAway * avgTimePerStop + 15,
            message: `🚚 Ready! Estimated ${stopsAway * avgTimePerStop + 15}-${stopsAway * avgTimePerStop + 30} minutes once driver starts route.`,
            routeProgress
        };
    }
    
    if (status === 'OUT_FOR_DELIVERY') {
        const minTime = Math.max(stopsAway * avgTimePerStop, 5);
        const maxTime = minTime + 15;
        
        return {
            eta: `${minTime}-${maxTime} min`,
            stopsAway: stopsAway,
            estimatedMinutes: minTime,
            message: stopsAway === 0 
                ? '🎉 Driver is heading to you now! Arriving in 5-15 minutes.'
                : `🚗 ${stopsAway} stop${stopsAway > 1 ? 's' : ''} before you. Estimated arrival: ${minTime}-${maxTime} minutes.`,
            routeProgress
        };
    }
    
    return {
        eta: 'Calculating...',
        stopsAway: null,
        estimatedMinutes: null,
        message: '⏳ Calculating delivery estimate...',
        routeProgress: null
    };
}

// Format order type
function getOrderType(takeOut) {
    const types = { 0: 'Dine-in', 1: 'Take Out', 2: 'Delivery' };
    return types[takeOut] || 'Unknown';
}

// Format driver/route name for display
function formatDriverName(deliveryAssociate) {
    if (!deliveryAssociate || deliveryAssociate === '""' || deliveryAssociate === '') {
        return null;
    }
    // Parse route name like "giga-north-1.19.26" or "kranthi-west-1.19.26"
    const cleaned = deliveryAssociate.replace(/"/g, '');
    const parts = cleaned.split('-');
    if (parts.length >= 2) {
        const driverName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        const zone = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
        return { driver: driverName, zone: zone, route: cleaned };
    }
    return { driver: cleaned, zone: 'N/A', route: cleaned };
}

// Format order response with full details
async function formatOrderResponse(order) {
    const items = order.menuList || [];
    
    // Format all items with price and quantity
    let itemsStr = '';
    if (items.length > 0) {
        itemsStr = items.map(item => {
            const qty = item.count || 1;
            const price = (item.salePrice || 0).toFixed(2);
            const total = (qty * (item.salePrice || 0)).toFixed(2);
            return `• ${item.menuItemName} x${qty} @ $${price} = $${total}`;
        }).join('\n');
    }
    
    // Delivery proof image (photo taken at delivery)
    let deliveryProofSection = '';
    if (order.orderStatus === 'DELIVERED') {
        if (order.imageUrl) {
            deliveryProofSection = `\n\n📸 **Delivery Proof Photo:**\n<!--DELIVERY_PROOF:${order.imageUrl}-->`;
        } else {
            deliveryProofSection = `\n\n📸 **Delivery Proof:** Photo not available for this order.`;
        }
    } else if (order.orderStatus === 'OUT_FOR_DELIVERY') {
        deliveryProofSection = `\n\n📸 **Delivery Proof:** Photo will be available after delivery.`;
    }
    
    // Calculate subtotal
    const subtotal = items.reduce((sum, item) => sum + ((item.salePrice || 0) * (item.count || 1)), 0);
    
    // Format order creation time
    const orderDate = order.orderCreationTimeStr || order.orderCreationTime || 'N/A';
    
    // Format delivery time
    let deliveryTime = order.requestedDeliveryDateString || order.requestedDeliveryDateStr || 'Pending';
    if (order.requestedDeliveryDate) {
        const reqDate = new Date(order.requestedDeliveryDate);
        deliveryTime += ` (${reqDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })})`;
    }
    
    // Order platform
    const platform = order.company || 'iPerkz';
    
    // Payment details
    const tax = order.tax || 0;
    const deliveryFee = order.deliveryAmount || 0;
    const tip = order.tipAmount || 0;
    const transactionFee = order.transactionFee || 0;
    const discount = order.discount || 0;
    const perkzUsed = order.perkzAmt || 0;
    const total = order.totalSalePrice || 0;
    
    // Driver/Route information
    const driverInfo = formatDriverName(order.deliveryAssociate);
    const packingAssociate = order.packingAssociate || null;
    const deliverySeq = order.deliverySeq || null;
    
    // Google Maps link
    const mapsUrl = getGoogleMapsUrl(order.address);
    const storeMapsUrl = getGoogleMapsUrl(order.storeAddress1);
    const directionsUrl = getDirectionsUrl(order.storeAddress1, order.address);
    
    // Progress timeline
    const progressTimeline = getProgressTimeline(order.orderStatus);
    
    // Delivery estimate (now async with live route data)
    const estimate = await getDeliveryEstimate(order, driverInfo);
    
    // Live route progress info
    let liveRouteSection = '';
    if (estimate.routeProgress) {
        const rp = estimate.routeProgress;
        liveRouteSection = `
📊 **LIVE Route Progress:**
━━━━━━━━━━━━━━━━━━━━━━
**Route:** ${rp.routeId}
**Progress:** ${rp.completedStops}/${rp.totalStops} stops completed (${rp.progressPercent}%)
**Driver Currently At:** ${rp.currentStopAddress || 'Starting route'}
${rp.lastDeliveredAddress ? `**Last Delivery:** ${rp.lastDeliveredAddress}` : ''}

[████${'█'.repeat(Math.floor(rp.progressPercent/10))}${'░'.repeat(10-Math.floor(rp.progressPercent/10))}] ${rp.progressPercent}%
`;
    }
    
    // Build delivery tracking section based on status
    let deliveryTrackingSection = '';
    if (order.orderStatus === 'PLACED') {
        deliveryTrackingSection = `
━━━━━━━━━━━━━━━━━━━━━━
🚚 **Delivery Tracking**
━━━━━━━━━━━━━━━━━━━━━━
**Packing Status:** ⏳ Awaiting packing
**Driver Assignment:** ⏳ Not yet assigned
**Route:** ⏳ Pending route optimization

⏱️ **Estimated Delivery:**
${estimate.message}

📍 **Delivery Location:**
${order.address || 'N/A'}
${mapsUrl ? `🗺️ View on Map: ${mapsUrl}` : ''}
${directionsUrl ? `🚗 Get Directions: ${directionsUrl}` : ''}

💡 Your order will be assigned to a driver once packing begins.`;
    } else if (order.orderStatus === 'STARTED') {
        deliveryTrackingSection = `
━━━━━━━━━━━━━━━━━━━━━━
🚚 **Delivery Tracking**
━━━━━━━━━━━━━━━━━━━━━━
**Packing Status:** 📦 Being packed${packingAssociate ? ` by ${packingAssociate}` : ''}
**Driver Assignment:** ⏳ Pending
**Route:** ⏳ Will be assigned after packing

⏱️ **Estimated Delivery:**
${estimate.message}

📍 **Delivery Location:**
${order.address || 'N/A'}
${mapsUrl ? `🗺️ View on Map: ${mapsUrl}` : ''}
${directionsUrl ? `🚗 Get Directions: ${directionsUrl}` : ''}`;
    } else if (order.orderStatus === 'COMPLETED' && driverInfo) {
        deliveryTrackingSection = `
━━━━━━━━━━━━━━━━━━━━━━
🚚 **Delivery Tracking**
━━━━━━━━━━━━━━━━━━━━━━
✅ **Order Packed & Ready!**

**Packed By:** ${packingAssociate || 'N/A'}
**Driver:** ${driverInfo.driver}
**Delivery Zone:** ${driverInfo.zone}
**Route ID:** ${driverInfo.route}
**Your Stop:** #${deliverySeq} in route

⏱️ **Estimated Delivery:**
${estimate.message}

📍 **Delivery Location:**
${order.address || 'N/A'}
${mapsUrl ? `🗺️ View on Map: ${mapsUrl}` : ''}
${directionsUrl ? `🚗 Get Directions from Store: ${directionsUrl}` : ''}

🔴 **Track Route:**
https://delivery-routes.vercel.app/driver`;
    } else if (order.orderStatus === 'OUT_FOR_DELIVERY' && driverInfo) {
        const driverTrackingUrl = `https://delivery-routes.vercel.app/driver`;
        deliveryTrackingSection = `
━━━━━━━━━━━━━━━━━━━━━━
🚚 **LIVE DELIVERY TRACKING**
━━━━━━━━━━━━━━━━━━━━━━
🟢 **Your order is on the way!**

⏱️ **ETA: ${estimate.eta}**
${estimate.message}

**Packed By:** ${packingAssociate || 'N/A'}
**Driver:** ${driverInfo.driver}
**Delivery Zone:** ${driverInfo.zone}
**Route ID:** ${driverInfo.route}
**Your Stop:** #${deliverySeq} in delivery sequence

📍 **Delivering To:**
${order.address || 'N/A'}
${mapsUrl ? `🗺️ View Location: ${mapsUrl}` : ''}
${directionsUrl ? `🚗 Directions from Store: ${directionsUrl}` : ''}

🔴 **TRACK DRIVER LIVE:**
${driverTrackingUrl}

📊 **Route Progress:**
${estimate.stopsAway === 0 ? '🎉 You are NEXT!' : `The driver has ${estimate.stopsAway} stop${estimate.stopsAway > 1 ? 's' : ''} before yours.`}
${liveRouteSection}
💡 Click the tracking link above to see the driver's current location!`;
    } else if (driverInfo) {
        const driverTrackingUrl = `https://delivery-routes.vercel.app/driver`;
        deliveryTrackingSection = `
━━━━━━━━━━━━━━━━━━━━━━
🚚 **Delivery Tracking**
━━━━━━━━━━━━━━━━━━━━━━
${estimate.message}

**Packed By:** ${packingAssociate || 'N/A'}
**Driver:** ${driverInfo.driver}
**Delivery Zone:** ${driverInfo.zone}
**Route ID:** ${driverInfo.route}
**Delivery Sequence:** #${deliverySeq} in route
${liveRouteSection}
📍 **Delivered To:**
${order.address || 'N/A'}
${mapsUrl ? `🗺️ View on Map: ${mapsUrl}` : ''}

🚗 **Driver Tracking Portal:**
${driverTrackingUrl}`;
    }
    
    return `📦 **Order #${order.customerOrderId}**

${getStatusDisplay(order.orderStatus)}

━━━━━━━━━━━━━━━━━━━━━━
📊 **Order Progress**
━━━━━━━━━━━━━━━━━━━━━━
${progressTimeline}

━━━━━━━━━━━━━━━━━━━━━━
👤 **Customer Details**
━━━━━━━━━━━━━━━━━━━━━━
**Name:** ${(order.firstName || '') + ' ' + (order.lastName || '')}
**Phone:** ${order.phone || 'N/A'}
**Email:** ${order.email || 'N/A'}
**Address:** ${order.address || 'N/A'}

━━━━━━━━━━━━━━━━━━━━━━
🏪 **Store Details**
━━━━━━━━━━━━━━━━━━━━━━
**Store:** ${order.storeName || 'iPerkz - Groceries'}
**Store Address:** ${order.storeAddress1 || 'N/A'}

━━━━━━━━━━━━━━━━━━━━━━
📋 **Order Details**
━━━━━━━━━━━━━━━━━━━━━━
**Order Date:** ${orderDate}
**Order Type:** ${getOrderType(order.takeOut)}
**Platform:** ${platform}
**Scheduled Delivery:** ${deliveryTime}
${order.deliveryInstructions ? `**Delivery Instructions:** ${order.deliveryInstructions}` : ''}
${order.specialInstructions ? `**Special Instructions:** ${order.specialInstructions}` : ''}
${deliveryTrackingSection}

━━━━━━━━━━━━━━━━━━━━━━
🛒 **Items Ordered (${items.length})**
━━━━━━━━━━━━━━━━━━━━━━
${itemsStr || 'No items found'}

━━━━━━━━━━━━━━━━━━━━━━
💰 **Payment Summary**
━━━━━━━━━━━━━━━━━━━━━━
**Subtotal:** $${subtotal.toFixed(2)}
**Tax:** $${tax.toFixed(2)}
**Delivery Fee:** $${deliveryFee.toFixed(2)}
**Tip:** $${tip.toFixed(2)}
${discount > 0 ? `**Discount:** -$${discount.toFixed(2)}` : ''}
${perkzUsed > 0 ? `**Perkz Used:** -$${perkzUsed.toFixed(2)}` : ''}
**Transaction Fee:** $${transactionFee.toFixed(2)}
**━━━━━━━━━━━━━━━━━━━━**
**Total Charged:** $${total.toFixed(2)}
**Payment Method:** ${order.paymentMode || 'N/A'}
${deliveryProofSection}

━━━━━━━━━━━━━━━━━━━━━━
📱 **Track Your Order**
━━━━━━━━━━━━━━━━━━━━━━
Download the iPerkz app for real-time tracking!
• iOS: ${IOS_APP}
• Android: ${ANDROID_APP}

Is there anything else I can help you with?`;
}

// Extract order ID from message
function extractOrderId(message) {
    // Check if just a number
    if (/^\d{3,10}$/.test(message.trim())) {
        return message.trim();
    }
    
    // Try to find order ID with keywords
    const match = message.match(/(?:order\s*(?:id|#|no)?:?\s*)(\d{4,10})/i);
    if (match) return match[1];
    
    // Try any number
    const numMatch = message.match(/\b(\d{4,10})\b/);
    if (numMatch) return numMatch[1];
    
    return null;
}

// Intent detection
function isGreeting(msg) {
    const greetings = ['hi', 'hello', 'hey', 'namaste', 'namaskar', 'good morning', 'good afternoon', 'good evening'];
    return greetings.some(g => msg.startsWith(g) || msg === g);
}

function isFarewell(msg) {
    const farewells = ['bye', 'goodbye', 'thanks bye', 'see you', 'take care'];
    return farewells.some(f => msg.includes(f));
}

function isThanks(msg) {
    const thanks = ['thank', 'thanks', 'dhanyavad', 'appreciate'];
    return thanks.some(t => msg.includes(t));
}

function isOrderQuery(msg) {
    if (/^\d{3,10}$/.test(msg.trim())) return true;
    const keywords = ['order', 'track', 'status', 'where is my', 'my order', 'tracking'];
    return keywords.some(k => msg.includes(k));
}

function isDeliveryQuery(msg) {
    const keywords = ['delivery', 'deliver', 'shipping', 'when will', 'arrival'];
    return keywords.some(k => msg.includes(k));
}

function isRefundQuery(msg) {
    const keywords = ['refund', 'cancel', 'money back', 'return'];
    return keywords.some(k => msg.includes(k));
}

function isAppQuery(msg) {
    const keywords = ['app', 'download', 'install', 'play store', 'app store'];
    return keywords.some(k => msg.includes(k));
}

// Pending verification state per session
const pendingVerifications = new Map();

// Response handlers
async function handleOrderQuery(message, sessionId) {
    const orderId = extractOrderId(message);
    
    if (!orderId) {
        return `To track your order, I'll need your Order ID. You can find it in:
• Your order confirmation notification
• 'My Orders' section in the iPerkz app
• Order confirmation email

Please share your Order ID (e.g., 64531) and I'll check the status for you! 📦

💡 **Tip:** Download the iPerkz app for real-time order tracking!`;
    }
    
    const order = await findOrderById(orderId);
    
    if (!order) {
        return `📦 **Order #${orderId}**

I couldn't find order #${orderId} in our system. This could mean:
• The order ID may be incorrect
• The order is still being processed
• The order may be from a different store

**Please verify your Order ID:**
• Check your order confirmation email
• Check 'My Orders' in the iPerkz app
• Contact support if the issue persists

📧 **Support:** support@iperkz.com

Would you like to try a different order ID?`;
    }
    
    // Check if already verified for this order
    const verifiedOrders = customerSessions.get(sessionId) || new Set();
    if (verifiedOrders.has(orderId)) {
        return formatOrderResponse(order);
    }
    
    // Store pending verification
    pendingVerifications.set(sessionId, { orderId, order });
    
    // Mask all customer info for security - hide everything
    const maskedPhone = order.phone ? `***-***-****` : 'N/A';
    const maskedEmail = order.email ? `***@***` : 'N/A';
    const maskedName = order.firstName ? `${'*'.repeat(order.firstName.length)}` : '***';
    
    return `🔐 **Verification Required**

For your security, I need to verify you own order #${orderId}.

**Order found for:** ${maskedName}
**Phone on file:** ${maskedPhone}
**Email on file:** ${maskedEmail}

Please reply with ONE of the following to verify:
• Your **phone number** (or last 4 digits)
• Your **email address**
• Your **first name**

🔒 This protects your order information from unauthorized access.`;
}

// Handle verification response
async function handleVerification(message, sessionId) {
    const pending = pendingVerifications.get(sessionId);
    
    if (!pending) {
        return null; // No pending verification
    }
    
    const { orderId, order } = pending;
    const identifier = message.trim();
    
    if (verifyCustomerOwnership(order, identifier)) {
        // Verification successful
        pendingVerifications.delete(sessionId);
        
        // Store verified session
        let verifiedOrders = customerSessions.get(sessionId);
        if (!verifiedOrders) {
            verifiedOrders = new Set();
            customerSessions.set(sessionId, verifiedOrders);
        }
        verifiedOrders.add(orderId);
        
        return `✅ **Verification Successful!**

Thank you for verifying your identity.

` + formatOrderResponse(order);
    } else {
        // Verification failed
        return `❌ **Verification Failed**

The information provided doesn't match our records for order #${orderId}.

**Please try again with:**
• Your phone number (or last 4 digits)
• Your email address
• Your first name as it appears on the order

💡 Make sure you're using the same contact info used when placing the order.

📧 Need help? Contact support@iperkz.com`;
    }
}

function getGreetingResponse() {
    return `🙏 **Namaste! Welcome to iPerkz Support!**

I'm here to help you with:

📦 **Order Related**
• Track your order
• Cancel or modify order
• Check order history

💰 **Refunds & Returns**
• Request refund
• Return policy

🚚 **Delivery**
• Delivery status
• Delivery hours

📱 **App Support**
• Download app
• App issues

How can I assist you today?`;
}

function getFarewellResponse() {
    return `🙏 Thank you for choosing iPerkz!

We hope you enjoy your groceries. Have a wonderful day!

📱 Don't forget to download our app for exclusive deals.

See you soon! 🛒`;
}

function getThanksResponse() {
    return `You're welcome! 😊

Is there anything else I can help you with today?`;
}

function getDeliveryResponse() {
    return `🚚 **Delivery Information**

**Delivery Hours:** 8:00 AM - 10:00 PM
**Standard Delivery Time:** 2-4 hours
**Free Delivery:** On orders above $50
**Delivery Charge:** $5 for orders below $50

To track your specific delivery, please share your Order ID.

💡 **Tip:** Use the iPerkz app for real-time delivery tracking!`;
}

function getRefundResponse() {
    return `💰 **Refund & Cancellation Policy**

**To Cancel an Order:**
• Open the iPerkz app
• Go to 'My Orders'
• Select your order and tap 'Cancel'
• Orders can only be cancelled before packing starts

**Refund Process:**
• Refunds are processed within 5-7 business days
• Amount will be credited to original payment method

📧 **Support:** support@iperkz.com`;
}

function getAppResponse() {
    return `📱 **Download the iPerkz App**

Get the best grocery shopping experience!

**Features:**
• Real-time order tracking
• Exclusive app-only deals
• Easy reordering
• Perkz rewards & cashback

**Download Now:**
• 🍎 iOS: ${IOS_APP}
• 🤖 Android: ${ANDROID_APP}

Get $5 OFF on your first app order!`;
}

function getDefaultResponse() {
    return `I'm here to help! Here's what I can assist you with:

• **Track Order** - Share your order ID
• **Delivery Info** - Ask about delivery times
• **Refunds** - Cancel or return orders
• **App Download** - Get our mobile app

Please share your Order ID or let me know how I can help!`;
}

// Process message
async function processMessage(message, sessionId) {
    if (!message || !message.trim()) {
        return getGreetingResponse();
    }
    
    const msg = message.toLowerCase().trim();
    
    // Check for pending verification first
    if (pendingVerifications.has(sessionId)) {
        const verificationResult = await handleVerification(message, sessionId);
        if (verificationResult) {
            return verificationResult;
        }
    }
    
    if (isGreeting(msg)) return getGreetingResponse();
    if (isFarewell(msg)) return getFarewellResponse();
    if (isThanks(msg)) return getThanksResponse();
    if (isOrderQuery(msg)) return await handleOrderQuery(message, sessionId);
    if (isDeliveryQuery(msg)) return getDeliveryResponse();
    if (isRefundQuery(msg)) return getRefundResponse();
    if (isAppQuery(msg)) return getAppResponse();
    
    return getDefaultResponse();
}

// API Routes
app.post('/api/chat', async (req, res) => {
    const { message, sessionId } = req.body;
    const session = sessionId || 'default-session';
    console.log(`[Chat] Session ${session}: ${message}`);
    
    const response = await processMessage(message, session);
    
    res.json({ response, success: true });
});

// Get order tracking data for map (requires session verification)
app.get('/api/track/:orderId', async (req, res) => {
    const orderId = req.params.orderId;
    const sessionId = req.query.sessionId || 'default-session';
    console.log(`[Track] Request for order #${orderId} from session ${sessionId}`);
    
    // Check if session is verified for this order
    const verifiedOrders = customerSessions.get(sessionId);
    if (!verifiedOrders || !verifiedOrders.has(orderId)) {
        console.log(`[Track] Session not verified for order #${orderId}`);
        res.json({ 
            success: false, 
            error: 'Please verify your identity in the chat first',
            requiresVerification: true
        });
        return;
    }
    
    const order = await findOrderById(orderId);
    
    if (order) {
        const driverInfo = formatDriverName(order.deliveryAssociate);
        const estimate = await getDeliveryEstimate(order, driverInfo);
        const directionsUrl = getDirectionsUrl(order.storeAddress1, order.address);
        
        // Get route progress for live tracking
        let routeProgress = null;
        if (driverInfo && driverInfo.route) {
            routeProgress = await getRouteProgress(driverInfo.route);
        }
        
        res.json({
            success: true,
            order: {
                orderId: order.customerOrderId,
                status: order.orderStatus,
                address: order.address,
                storeAddress: order.storeAddress1,
                storeName: order.storeName,
                driver: driverInfo ? driverInfo.driver : null,
                zone: driverInfo ? driverInfo.zone : null,
                route: driverInfo ? driverInfo.route : null,
                deliverySeq: order.deliverySeq,
                packedBy: order.packingAssociate,
                scheduledDelivery: order.requestedDeliveryDateString || order.requestedDeliveryDateStr,
                customerName: `${order.firstName || ''} ${order.lastName || ''}`.trim(),
                // ETA information
                eta: estimate.eta,
                stopsAway: estimate.stopsAway,
                estimatedMinutes: estimate.estimatedMinutes,
                etaMessage: estimate.message,
                directionsUrl: directionsUrl,
                // Live route progress
                routeProgress: routeProgress ? {
                    totalStops: routeProgress.totalStops,
                    completedStops: routeProgress.completedStops,
                    progressPercent: routeProgress.progressPercent,
                    currentStopAddress: routeProgress.currentStopAddress,
                    lastDeliveredAddress: routeProgress.lastDeliveredAddress
                } : null
            }
        });
    } else {
        res.json({ success: false, error: 'Order not found' });
    }
});

// Get all active driver locations
app.get('/api/drivers', apiLimiter, async (req, res) => {
    console.log('[API] Fetching all driver locations');
    const locations = await fetchDriverLocations();
    res.json({ success: true, drivers: locations });
});

// Get driver location for a specific order
app.get('/api/driver-location/:orderId', apiLimiter, async (req, res) => {
    const orderId = req.params.orderId;
    const sessionId = req.query.sessionId || req.headers['x-session-id'] || 'default-session';
    console.log(`[Track] Driver location request for order #${orderId}`);
    
    // Check if session is verified for this order
    const verifiedOrders = customerSessions.get(sessionId);
    if (!verifiedOrders || !verifiedOrders.has(orderId)) {
        res.json({ 
            success: false, 
            error: 'Please verify your identity first',
            requiresVerification: true,
            code: 'VERIFICATION_REQUIRED'
        });
        return;
    }
    
    const order = await findOrderById(orderId);
    
    if (!order) {
        res.json({ success: false, error: 'Order not found', code: 'ORDER_NOT_FOUND' });
        return;
    }
    
    if (order.orderStatus !== 'OUT_FOR_DELIVERY') {
        res.json({ 
            success: false, 
            error: 'Driver location available only when out for delivery',
            orderStatus: order.orderStatus,
            code: 'NOT_OUT_FOR_DELIVERY'
        });
        return;
    }
    
    const driverInfo = formatDriverName(order.deliveryAssociate);
    if (!driverInfo) {
        res.json({ success: false, error: 'No driver assigned', code: 'NO_DRIVER' });
        return;
    }
    
    // Find driver location
    const driverLocation = await findDriverByRoute(driverInfo.route);
    const routeProgress = await getRouteProgress(driverInfo.route);
    
    res.json({
        success: true,
        order: {
            orderId: order.customerOrderId,
            status: order.orderStatus,
            address: order.address,
            deliverySeq: order.deliverySeq,
            customerName: `${order.firstName || ''} ${order.lastName || ''}`.trim()
        },
        driver: {
            name: driverInfo.driver,
            zone: driverInfo.zone,
            route: driverInfo.route,
            location: driverLocation ? {
                latitude: parseFloat(driverLocation.latitude),
                longitude: parseFloat(driverLocation.longitude),
                heading: driverLocation.heading,
                speed: driverLocation.speed,
                lastUpdated: driverLocation.last_updated,
                isActive: driverLocation.is_active
            } : null
        },
        routeProgress: routeProgress ? {
            totalStops: routeProgress.totalStops,
            completedStops: routeProgress.completedStops,
            progressPercent: routeProgress.progressPercent,
            currentStopSeq: routeProgress.currentStopSeq
        } : null
    });
});

// ============================================
// MOBILE API ENDPOINTS (v1)
// ============================================

// Mobile: Generate session token
app.post('/api/v1/session', apiLimiter, (req, res) => {
    const { deviceId, platform, appVersion } = req.body;
    
    if (!deviceId) {
        return res.status(400).json({ 
            success: false, 
            error: 'Device ID required',
            code: 'MISSING_DEVICE_ID'
        });
    }
    
    // Generate secure session token
    const sessionToken = uuidv4();
    const timestamp = Date.now();
    
    // Create session with expiry
    const sessionData = {
        deviceId,
        platform: platform || 'unknown',
        appVersion: appVersion || '1.0.0',
        createdAt: timestamp,
        expiresAt: timestamp + SESSION_EXPIRY,
        verifiedOrders: new Set()
    };
    
    customerSessions.set(sessionToken, sessionData);
    
    console.log(`[Mobile] New session created for device ${deviceId.slice(0, 8)}... on ${platform}`);
    
    res.json({
        success: true,
        sessionToken,
        expiresIn: SESSION_EXPIRY,
        apiVersion: API_VERSION
    });
});

// Mobile: Chat endpoint with session validation
app.post('/api/v1/chat', apiLimiter, async (req, res) => {
    const { message } = req.body;
    const sessionToken = req.headers['authorization']?.replace('Bearer ', '') || req.body.sessionId;
    
    if (!sessionToken) {
        return res.status(401).json({
            success: false,
            error: 'Session token required',
            code: 'UNAUTHORIZED'
        });
    }
    
    // Validate session
    const session = customerSessions.get(sessionToken);
    if (!session) {
        // For backward compatibility, create temporary session
        customerSessions.set(sessionToken, { verifiedOrders: new Set() });
    } else if (session.expiresAt && Date.now() > session.expiresAt) {
        customerSessions.delete(sessionToken);
        return res.status(401).json({
            success: false,
            error: 'Session expired',
            code: 'SESSION_EXPIRED'
        });
    }
    
    console.log(`[Mobile Chat] Session ${sessionToken.slice(0, 8)}...: ${message}`);
    
    const response = await processMessage(message, sessionToken);
    
    res.json({ 
        success: true, 
        response,
        timestamp: Date.now()
    });
});

// Mobile: Track order
app.get('/api/v1/orders/:orderId/track', apiLimiter, async (req, res) => {
    const orderId = req.params.orderId;
    const sessionToken = req.headers['authorization']?.replace('Bearer ', '') || req.query.sessionId;
    
    if (!sessionToken) {
        return res.status(401).json({
            success: false,
            error: 'Session token required',
            code: 'UNAUTHORIZED'
        });
    }
    
    // Check verification
    const session = customerSessions.get(sessionToken);
    const verifiedOrders = session?.verifiedOrders || session;
    
    if (!verifiedOrders || !(verifiedOrders instanceof Set ? verifiedOrders.has(orderId) : verifiedOrders.has?.(orderId))) {
        return res.json({
            success: false,
            error: 'Please verify your identity first',
            code: 'VERIFICATION_REQUIRED',
            requiresVerification: true
        });
    }
    
    const order = await findOrderById(orderId);
    
    if (!order) {
        return res.json({ 
            success: false, 
            error: 'Order not found',
            code: 'ORDER_NOT_FOUND'
        });
    }
    
    const driverInfo = formatDriverName(order.deliveryAssociate);
    const estimate = await getDeliveryEstimate(order, driverInfo);
    const directionsUrl = getDirectionsUrl(order.storeAddress1, order.address);
    
    let routeProgress = null;
    let driverLocation = null;
    
    if (driverInfo && driverInfo.route) {
        routeProgress = await getRouteProgress(driverInfo.route);
        if (order.orderStatus === 'OUT_FOR_DELIVERY') {
            driverLocation = await findDriverByRoute(driverInfo.route);
        }
    }
    
    res.json({
        success: true,
        order: {
            orderId: order.customerOrderId,
            status: order.orderStatus,
            statusDisplay: getStatusDisplay(order.orderStatus),
            address: order.address,
            storeAddress: order.storeAddress1,
            storeName: order.storeName,
            customerName: `${order.firstName || ''} ${order.lastName || ''}`.trim(),
            scheduledDelivery: order.requestedDeliveryDateString || order.requestedDeliveryDateStr,
            deliverySeq: order.deliverySeq,
            packedBy: order.packingAssociate,
            items: (order.menuList || []).map(item => ({
                name: item.menuItemName,
                quantity: item.count || 1,
                price: item.salePrice || 0
            })),
            total: order.totalSalePrice,
            deliveryProofImage: order.orderStatus === 'DELIVERED' ? order.imageUrl : null
        },
        driver: driverInfo ? {
            name: driverInfo.driver,
            zone: driverInfo.zone,
            route: driverInfo.route,
            location: driverLocation ? {
                latitude: parseFloat(driverLocation.latitude),
                longitude: parseFloat(driverLocation.longitude),
                heading: driverLocation.heading,
                speed: driverLocation.speed,
                lastUpdated: driverLocation.last_updated,
                isActive: driverLocation.is_active
            } : null
        } : null,
        eta: {
            display: estimate.eta,
            minutes: estimate.estimatedMinutes,
            stopsAway: estimate.stopsAway,
            message: estimate.message
        },
        routeProgress: routeProgress ? {
            totalStops: routeProgress.totalStops,
            completedStops: routeProgress.completedStops,
            progressPercent: routeProgress.progressPercent,
            currentStopAddress: routeProgress.currentStopAddress
        } : null,
        links: {
            directions: directionsUrl
        },
        timestamp: Date.now()
    });
});

// Mobile: Verify order ownership
app.post('/api/v1/orders/:orderId/verify', strictLimiter, async (req, res) => {
    const orderId = req.params.orderId;
    const { identifier } = req.body;
    const sessionToken = req.headers['authorization']?.replace('Bearer ', '') || req.body.sessionId;
    
    if (!sessionToken) {
        return res.status(401).json({
            success: false,
            error: 'Session token required',
            code: 'UNAUTHORIZED'
        });
    }
    
    if (!identifier) {
        return res.status(400).json({
            success: false,
            error: 'Verification identifier required',
            code: 'MISSING_IDENTIFIER'
        });
    }
    
    const order = await findOrderById(orderId);
    
    if (!order) {
        return res.json({
            success: false,
            error: 'Order not found',
            code: 'ORDER_NOT_FOUND'
        });
    }
    
    const verified = verifyCustomerOwnership(order, identifier);
    
    if (verified) {
        // Get or create session data
        let session = customerSessions.get(sessionToken);
        if (!session) {
            session = { verifiedOrders: new Set() };
            customerSessions.set(sessionToken, session);
        }
        
        // Add verified order
        if (session.verifiedOrders) {
            session.verifiedOrders.add(orderId);
        } else if (session instanceof Set) {
            session.add(orderId);
        } else {
            // Legacy format
            customerSessions.set(sessionToken, new Set([orderId]));
        }
        
        console.log(`[Mobile] Order #${orderId} verified for session ${sessionToken.slice(0, 8)}...`);
        
        return res.json({
            success: true,
            message: 'Verification successful',
            orderId,
            canTrack: true
        });
    } else {
        return res.json({
            success: false,
            error: 'Verification failed. Please check your information.',
            code: 'VERIFICATION_FAILED'
        });
    }
});

// Mobile: Get driver live location
app.get('/api/v1/orders/:orderId/driver-location', apiLimiter, async (req, res) => {
    const orderId = req.params.orderId;
    const sessionToken = req.headers['authorization']?.replace('Bearer ', '') || req.query.sessionId;
    
    if (!sessionToken) {
        return res.status(401).json({
            success: false,
            error: 'Session token required',
            code: 'UNAUTHORIZED'
        });
    }
    
    // Check verification
    const session = customerSessions.get(sessionToken);
    const verifiedOrders = session?.verifiedOrders || session;
    
    if (!verifiedOrders || !(verifiedOrders instanceof Set ? verifiedOrders.has(orderId) : false)) {
        return res.json({
            success: false,
            error: 'Please verify your identity first',
            code: 'VERIFICATION_REQUIRED'
        });
    }
    
    const order = await findOrderById(orderId);
    
    if (!order) {
        return res.json({ success: false, error: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    
    if (order.orderStatus !== 'OUT_FOR_DELIVERY') {
        return res.json({
            success: false,
            error: 'Driver location available only when order is out for delivery',
            orderStatus: order.orderStatus,
            code: 'NOT_OUT_FOR_DELIVERY'
        });
    }
    
    const driverInfo = formatDriverName(order.deliveryAssociate);
    if (!driverInfo) {
        return res.json({ success: false, error: 'No driver assigned', code: 'NO_DRIVER' });
    }
    
    const driverLocation = await findDriverByRoute(driverInfo.route);
    const routeProgress = await getRouteProgress(driverInfo.route);
    
    let stopsAway = order.deliverySeq;
    if (routeProgress) {
        stopsAway = order.deliverySeq - routeProgress.completedStops;
        if (stopsAway < 0) stopsAway = 0;
    }
    
    res.json({
        success: true,
        driver: {
            name: driverInfo.driver,
            zone: driverInfo.zone,
            location: driverLocation ? {
                latitude: parseFloat(driverLocation.latitude),
                longitude: parseFloat(driverLocation.longitude),
                heading: driverLocation.heading,
                speed: driverLocation.speed,
                lastUpdated: driverLocation.last_updated,
                isActive: driverLocation.is_active
            } : null
        },
        delivery: {
            address: order.address,
            seq: order.deliverySeq,
            stopsAway: stopsAway,
            isNext: stopsAway === 0
        },
        routeProgress: routeProgress ? {
            totalStops: routeProgress.totalStops,
            completedStops: routeProgress.completedStops,
            progressPercent: routeProgress.progressPercent
        } : null,
        timestamp: Date.now()
    });
});

// Health check with version info
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        service: 'iPerkz Support Agent',
        version: '2.0.0',
        apiVersion: API_VERSION,
        timestamp: Date.now()
    });
});

// API info endpoint for mobile apps
app.get('/api/v1/info', (req, res) => {
    res.json({
        success: true,
        api: {
            version: API_VERSION,
            baseUrl: '/api/v1',
            endpoints: {
                session: 'POST /api/v1/session',
                chat: 'POST /api/v1/chat',
                trackOrder: 'GET /api/v1/orders/:orderId/track',
                verifyOrder: 'POST /api/v1/orders/:orderId/verify',
                driverLocation: 'GET /api/v1/orders/:orderId/driver-location'
            }
        },
        apps: {
            ios: IOS_APP,
            android: ANDROID_APP
        }
    });
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('[Error]', err.message);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
    });
});

// Start server
app.listen(PORT, () => {
    console.log('');
    console.log('🛒 iPerkz Support Agent v2.0 - Mobile Ready');
    console.log(`🌐 Web: http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/v1`);
    console.log(`📱 iOS: ${IOS_APP}`);
    console.log(`📱 Android: ${ANDROID_APP}`);
    console.log('');
});
