const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ===========================================
// CONFIGURATION - Set these as environment variables on Render
// ===========================================
const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY || '';
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY || '';
const PRINTNODE_PRINTER_ID = parseInt(process.env.PRINTNODE_PRINTER_ID) || 0;

const ORIGIN_ADDRESS = {
    name: 'Wafaa Demian',
    street1: '90 W 22nd St',
    city: 'Bayonne',
    state: 'NJ',
    zip: '07002',
    country: 'US'
};
// ===========================================

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json'
};

function shippoRequest(endpoint, method, data) {
    return new Promise((resolve, reject) => {
        const postData = data ? JSON.stringify(data) : '';
        const options = {
            hostname: 'api.goshippo.com',
            path: endpoint,
            method: method,
            headers: {
                'Authorization': 'ShippoToken ' + SHIPPO_API_KEY,
                'Content-Type': 'application/json'
            }
        };
        if (data) {
            options.headers['Content-Length'] = Buffer.byteLength(postData);
        }

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });

        req.on('error', reject);
        if (data) req.write(postData);
        req.end();
    });
}

// Get rates for each package separately
async function getRatesForPackages(packages, destination) {
    const addressTo = {
        name: destination.name,
        street1: destination.street,
        street2: destination.street2 || '',
        city: destination.city,
        state: destination.state,
        zip: destination.zip,
        country: 'US',
        phone: destination.phone,
        email: destination.email
    };

    // Create a shipment for each package to get individual rates
    const shipmentPromises = packages.map(async (pkg, index) => {
        const shipmentData = {
            address_from: ORIGIN_ADDRESS,
            address_to: addressTo,
            parcels: [{
                length: pkg.length,
                width: pkg.width,
                height: pkg.height,
                distance_unit: 'in',
                weight: pkg.weight,
                mass_unit: 'lb'
            }],
            async: false
        };

        const result = await shippoRequest('/shipments', 'POST', shipmentData);

        if (result.status !== 201 && result.status !== 200) {
            throw new Error(result.data.detail || `Failed to create shipment for package ${index + 1}`);
        }

        return {
            packageIndex: index,
            shipment_id: result.data.object_id,
            rates: result.data.rates || []
        };
    });

    const shipments = await Promise.all(shipmentPromises);

    // Group rates by carrier/service and calculate totals
    const rateMap = new Map();

    shipments.forEach(shipment => {
        shipment.rates.forEach(rate => {
            const key = `${rate.provider}-${rate.servicelevel.token}`;
            if (!rateMap.has(key)) {
                rateMap.set(key, {
                    provider: rate.provider,
                    servicelevel: rate.servicelevel,
                    estimated_days: rate.estimated_days,
                    total_amount: 0,
                    currency: rate.currency,
                    package_rates: []
                });
            }
            const grouped = rateMap.get(key);
            grouped.total_amount += parseFloat(rate.amount);
            grouped.package_rates.push({
                packageIndex: shipment.packageIndex,
                rate_id: rate.object_id,
                amount: rate.amount
            });
        });
    });

    // Only return rates that are available for ALL packages
    const completeRates = [];
    rateMap.forEach((value, key) => {
        if (value.package_rates.length === packages.length) {
            completeRates.push({
                key: key,
                provider: value.provider,
                servicelevel: value.servicelevel,
                estimated_days: value.estimated_days,
                amount: value.total_amount.toFixed(2),
                currency: value.currency,
                package_rates: value.package_rates
            });
        }
    });

    return completeRates;
}

async function purchaseLabel(rateId) {
    const transactionData = {
        rate: rateId,
        label_file_type: 'PDF',
        async: false
    };

    const result = await shippoRequest('/transactions', 'POST', transactionData);

    if (result.status !== 201 && result.status !== 200) {
        throw new Error(result.data.detail || JSON.stringify(result.data) || 'Failed to purchase label');
    }

    if (result.data.status === 'ERROR') {
        const messages = result.data.messages || [];
        const errorMsg = messages.map(m => m.text).join(', ') || 'Label purchase failed';
        throw new Error(errorMsg);
    }

    return {
        tracking_number: result.data.tracking_number,
        label_url: result.data.label_url,
        tracking_url: result.data.tracking_url_provider,
        transaction_id: result.data.object_id
    };
}

// Purchase labels for all packages
async function purchaseAllLabels(packageRates) {
    const results = [];

    for (let i = 0; i < packageRates.length; i++) {
        const rate = packageRates[i];
        console.log(`Purchasing label for package ${rate.packageIndex + 1}...`);
        const labelInfo = await purchaseLabel(rate.rate_id);
        results.push({
            packageIndex: rate.packageIndex,
            tracking_number: labelInfo.tracking_number,
            label_url: labelInfo.label_url,
            tracking_url: labelInfo.tracking_url
        });
    }

    return results;
}

// PrintNode API request
function printNodeRequest(endpoint, method, data) {
    return new Promise((resolve, reject) => {
        const postData = data ? JSON.stringify(data) : '';
        const auth = Buffer.from(PRINTNODE_API_KEY + ':').toString('base64');

        const options = {
            hostname: 'api.printnode.com',
            path: endpoint,
            method: method,
            headers: {
                'Authorization': 'Basic ' + auth,
                'Content-Type': 'application/json'
            }
        };

        if (data) {
            options.headers['Content-Length'] = Buffer.byteLength(postData);
        }

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });

        req.on('error', reject);
        if (data) req.write(postData);
        req.end();
    });
}

// Print shipping labels via PrintNode
async function printLabels(labelUrls, customerName) {
    console.log('\n========== PRINTING LABELS VIA PRINTNODE ==========');
    console.log('Number of labels:', labelUrls.length);

    if (PRINTNODE_API_KEY === 'YOUR_PRINTNODE_API_KEY' || PRINTNODE_PRINTER_ID === 0) {
        console.log('PrintNode not configured - skipping print');
        console.log('Label URLs:', labelUrls);
        console.log('==========================================\n');
        return false;
    }

    try {
        for (let i = 0; i < labelUrls.length; i++) {
            const url = labelUrls[i];
            console.log(`Sending label ${i + 1} to printer...`);

            const printJob = {
                printerId: PRINTNODE_PRINTER_ID,
                title: `Shipping Label ${i + 1} - ${customerName}`,
                contentType: 'pdf_uri',
                content: url,
                source: 'El Wafaa Shipping'
            };

            const result = await printNodeRequest('/printjobs', 'POST', printJob);

            if (result.status === 201) {
                console.log(`  Label ${i + 1} sent! Job ID: ${result.data}`);
            } else {
                console.error(`  Failed to print label ${i + 1}:`, result.data);
            }
        }

        console.log('All labels sent to printer!');
        console.log('==========================================\n');
        return true;
    } catch (error) {
        console.error('PrintNode error:', error.message);
        console.log('==========================================\n');
        return false;
    }
}

// Log order details for reference
function logOrderDetails(destination, labelResults, packages) {
    const trackingList = labelResults.map((l, i) =>
        `Package ${i + 1}: ${l.tracking_number}`
    ).join('\n');

    const labelList = labelResults.map((l, i) =>
        `Package ${i + 1}: ${l.label_url}`
    ).join('\n');

    console.log('\n========== NEW ORDER ==========');
    console.log(`Customer: ${destination.name}`);
    console.log(`Address: ${destination.street}${destination.street2 ? ', ' + destination.street2 : ''}`);
    console.log(`         ${destination.city}, ${destination.state} ${destination.zip}`);
    console.log(`Email: ${destination.email}`);
    console.log(`Phone: ${destination.phone}`);
    console.log(`\nTracking Numbers:\n${trackingList}`);
    console.log(`\nLabel URLs:\n${labelList}`);
    console.log(`\nPackages: ${packages.length}`);
    packages.forEach((p, i) => console.log(`  Package ${i + 1}: ${p.length}"x${p.width}"x${p.height}", ${p.weight} lbs`));
    console.log('================================\n');
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // API: Get shipping rates
    if (req.url === '/api/rates' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { packages, destination } = JSON.parse(body);
                const rates = await getRatesForPackages(packages, destination);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ rates }));
            } catch (error) {
                console.error('Rates error:', error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
        return;
    }

    // API: Purchase labels for all packages
    if (req.url === '/api/purchase' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { package_rates, packages, destination } = JSON.parse(body);

                // Purchase a label for each package
                const labelResults = await purchaseAllLabels(package_rates);

                // Print labels via PrintNode
                printLabels(
                    labelResults.map(l => l.label_url),
                    destination.name
                );

                // Log order details for reference
                logOrderDetails(destination, labelResults, packages);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    labels: labelResults
                }));
            } catch (error) {
                console.error('Purchase error:', error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
        return;
    }

    // Serve static files
    const urlPath = req.url.split('?')[0];
    let filePath = urlPath === '/' ? '/admin.html' : urlPath;
    filePath = path.join(__dirname, filePath);

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Admin page: http://localhost:${PORT}/admin.html`);
});
