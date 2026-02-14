// server.js – ForensicKit Backend with CDR Upload
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
// Allow requests from React frontend
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true
}));
app.use(express.json());

// PostgreSQL connection pool using DATABASE_URL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Supabase
    }
});

// Configure multer for file upload (memory storage)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// ============================================
// TEST ENDPOINT
// ============================================
app.get('/api/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() as current_time, current_database() as db_name');
        res.json({
            success: true,
            message: '✅ Database connected successfully!',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Database connection error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Database connection failed',
            error: error.message
        });
    }
});

// ============================================
// CDR UPLOAD ENDPOINT
// ============================================
app.post('/api/cdr/upload', upload.single('file'), async (req, res) => {
    try {
        // Check if file was uploaded
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        const fileBuffer = req.file.buffer;
        const fileName = req.file.originalname;
        const analystId = req.body.analyst_id || 1;
        const caseId = req.body.case_id || 'CASE-001';

        // STEP 1: Calculate SHA-256 hash
        const sha256Hash = crypto
            .createHash('sha256')
            .update(fileBuffer)
            .digest('hex');

        // STEP 2: Create evidence manifest
        const manifestId = uuidv4();
        await pool.query(
            `INSERT INTO evidence_manifests 
            (id, file_name, sha256_hash, file_size_bytes, analyst_id, case_id, acquisition_time, integrity_status)
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)`,
            [manifestId, fileName, sha256Hash, fileBuffer.length, analystId, caseId, 'VERIFIED']
        );

        // STEP 3: Parse CSV file
        const fileContent = fileBuffer.toString('utf-8');
        const lines = fileContent.split('\n');
        
        let recordsInserted = 0;
        const errors = [];

        // Process each line (skip header)
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const values = line.split(',');
            if (values.length < 5) continue;

            try {
                const callingNumber = values[0]?.trim() || null;
                const calledNumber = values[1]?.trim() || null;
                const callStart = values[2]?.trim() || null;
                const durationSeconds = parseInt(values[3]?.trim()) || 0;
                const callType = values[4]?.trim() || 'VOICE';
                const cellId = values[5]?.trim() || null;
                const imei = values[6]?.trim() || null;

                await pool.query(
                    `INSERT INTO cdr_records 
                    (calling_number, called_number, call_start, duration_seconds, call_type, cell_id, imei, evidence_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [callingNumber, calledNumber, callStart, durationSeconds, callType, cellId, imei, manifestId]
                );
                recordsInserted++;
            } catch (err) {
                errors.push(`Line ${i + 1}: ${err.message}`);
            }
        }

        res.json({
            success: true,
            message: 'CDR file processed successfully',
            data: {
                evidence_id: manifestId,
                sha256_hash: sha256Hash,
                records_inserted: recordsInserted,
                errors: errors.length > 0 ? errors : null
            }
        });

    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process CDR file',
            error: error.message
        });
    }
});

// ============================================
// GET ALL CDR RECORDS
// ============================================
app.get('/api/cdr', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM cdr_records ORDER BY id DESC LIMIT 100'
        );
        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to fetch CDR records',
            error: error.message
        });
    }
});

// ============================================
// GET STATISTICS
// ============================================
app.get('/api/statistics', async (req, res) => {
    try {
        const cdrCount = await pool.query('SELECT COUNT(*) FROM cdr_records');
        const anomalyCount = await pool.query('SELECT COUNT(*) FROM anomalies');
        
        res.json({
            success: true,
            data: {
                total_cdr: parseInt(cdrCount.rows[0].count),
                total_anomalies: parseInt(anomalyCount.rows[0].count)
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to fetch statistics',
            error: error.message
        });
    }
});

// ============================================
// ROOT ENDPOINT
// ============================================
app.get('/', (req, res) => {
    res.json({
        name: 'ForensicKit Backend API',
        version: '1.0.0',
        status: 'running',
        endpoints: [
            '/api/test-db',
            '/api/cdr/upload (POST)',
            '/api/cdr (GET)',
            '/api/statistics',
            '/api/anomalies (GET)'
        ]
    });
});

// ============================================
// GET ANOMALIES ENDPOINT
// ============================================
app.get('/api/anomalies', async (req, res) => {
    try {
        const limit = req.query.limit || 20;
        
        const result = await pool.query(`
            SELECT a.*, c.calling_number, c.called_number, c.call_start, c.duration_seconds
            FROM anomalies a
            JOIN cdr_records c ON a.record_id = c.id
            WHERE a.record_type = 'CDR'
            ORDER BY a.detection_time DESC
            LIMIT $1
        `, [limit]);
        
        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to fetch anomalies',
            error: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 ForensicKit Backend API v1.0.0`);
    console.log(`========================================`);
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ Database: Connected via DATABASE_URL`);
    console.log(`✅ Endpoints ready:`);
    console.log(`   - POST /api/cdr/upload`);
    console.log(`   - GET  /api/cdr`);
    console.log(`   - GET  /api/statistics`);
    console.log(`   - GET  /api/test-db`);
    console.log(`   - GET  /api/anomalies`);
    console.log(`========================================`);
});