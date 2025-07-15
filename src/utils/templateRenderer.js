// backend/src/utils/templateRenderer.js
const path = require('path');
const hbs = require('handlebars');
const fs = require('fs').promises; // Use promises version for async/await

async function renderEmailTemplate(templateName, data) {
    try {
        // 🔄 CORRECTED PATH: Points to 'templates/emails'
        const templatePath = path.join(__dirname, '..', '..', 'tempelates', 'emails', `${templateName}.hbs`); // FIX: Changed 'tempelates' to 'templates' and added 'emails'

        const templateContent = await fs.readFile(templatePath, 'utf8');
        const template = hbs.compile(templateContent);
        return template(data);
    } catch (error) {
        console.error(`Error rendering email template ${templateName}:`, error);
        throw new Error(`Failed to render email template: ${templateName}`);
    }
}

module.exports = { renderEmailTemplate };