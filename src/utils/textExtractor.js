// src/utils/textExtractor.js

const parser = require('officeparser'); // Correct: 'parser' is now the officeparser module
const path = require('path');
const fs = require('fs');

/**
 * Extracts all textual content from a .pptx file.
 * @param {string} filePath - The absolute path to the PPTX file.
 * @returns {Promise<string>} A promise that resolves to the combined text content of the PPTX, or rejects if extraction fails.
 */
async function extractTextFromPptx(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }
    const fileExtension = path.extname(filePath).toLowerCase();
    if (fileExtension !== '.pptx' && fileExtension !== '.ppt') { // Note: officeparser supports .doc, .docx, .xls, .xlsx, .ppt, .pptx
        throw new Error(`Unsupported file extension: ${fileExtension}. Only .pptx and .ppt files are supported for now.`);
    }

    try {
        // officeparser's main async parse function is parseOfficeAsync
        // It extracts text from various Office formats, including PPTX
        const text = await parser.parseOfficeAsync(filePath); // <-- CORRECTED LINE HERE!
        return text.trim();
    } catch (error) {
        console.error(`[PPTX Text Extraction Error] Failed to extract text from ${filePath} using officeparser:`, error);
        throw new Error(`Failed to extract text from PPTX: ${error.message}`);
    }
}

// You can add more extraction functions here later, e.g., for PDFs
// We will integrate PDF extraction here later using a different library for PDFs
// async function extractTextFromPdf(filePath) { /* ... */ }

module.exports = {
    extractTextFromPptx,
    // Add other extraction functions here as you implement them
    // extractTextFromPdf,
};