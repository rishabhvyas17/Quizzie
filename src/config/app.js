// config/app.js
const express = require('express');
const path = require('path');
const hbs = require('hbs');
const session = require('express-session');
const MongoStore = require('connect-mongo');

// Load environment variables
require('dotenv').config();

const configureApp = (app) => {
    // Basic Express configuration
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(express.static(path.join(__dirname, '../../public')));

    // Template engine configuration
    const templatePath = path.join(__dirname, '../../tempelates');
    app.set("view engine", "hbs");
    app.set("views", templatePath);

    // Configure session middleware with MongoDB store
    app.use(session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        store: MongoStore.create({
            mongoUrl: process.env.MONGODB_URI,
            ttl: 14 * 24 * 60 * 60, // 14 days
            autoRemove: 'interval',
            autoRemoveInterval: 10 // 10 minutes
        }),
        cookie: {
            maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
            secure: false, // Set to true in production with HTTPS
            httpOnly: true,
            sameSite: 'lax'
        },
        proxy: true
    }));

    // Register Handlebars helpers
    registerHandlebarsHelpers();

    console.log('✅ Express app configured successfully');
};

const registerHandlebarsHelpers = () => {
    // Equality helper
    hbs.registerHelper('eq', function (a, b) {
        return a === b;
    });

    // Addition helper
    hbs.registerHelper('add', function (a, b) {
        return a + b;
    });

    // Score class helper for styling
    hbs.registerHelper('getScoreClass', function (percentage) {
        if (percentage >= 90) return 'excellent';
        if (percentage >= 70) return 'good';
        if (percentage >= 50) return 'average';
        return 'poor';
    });

    // Time formatting helper
    hbs.registerHelper('formatTime', function (seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${minutes}m ${secs}s`;
    });

    // JSON stringify helper
    hbs.registerHelper('json', function (context) {
        return JSON.stringify(context);
    });

    // Ranking class helper
    hbs.registerHelper('getRankClass', function (index) {
        if (index === 0) return 'rank-1';
        if (index === 1) return 'rank-2';
        if (index === 2) return 'rank-3';
        return 'rank-other';
    });

    // Date formatting helper
    hbs.registerHelper('formatDate', function (date) {
        return new Date(date).toLocaleDateString();
    });

    // Percentage formatting helper
    hbs.registerHelper('toFixed', function (number, decimals) {
        return parseFloat(number).toFixed(decimals || 1);
    });

    console.log('✅ Handlebars helpers registered successfully');
};

module.exports = { configureApp };