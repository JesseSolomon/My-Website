const express = require("express");
const mysql = require("mysql");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const htmlParser = require("node-html-parser");
const { error } = require("console");
const { join } = require("path");

/**
 * @returns {Promise<{ require(key: string, type: "string" | "number" | "boolean"): void, [key: string]: string | number | boolean }>}
 */
const env = () => new Promise(resolve => {
	class EnvironmentError extends Error {
		constructor(error) {
			super(`Invalid Environment: ${error}`);
		}
	}

	if (fs.existsSync(".env")) {
		let env = {};
		let pairs = fs.readFileSync(".env").toString()
			.split(/\n\r?/g)
			.filter(line => /\w+\s*=.+/g.test(line))
			.map(line => line.split(/=(.+)/).map(i => i.trim()));

		for (let pair of pairs) {
			let [key, value] = pair;

			env[key] = JSON.parse(value);
		}

		env.require = (key, type) => {
			if (!(key in env) || !(typeof env[key] === type)) {
				throw new EnvironmentError(`Environment requires key "${key}" of type "${type}"`);
			}
		}

		resolve(env);
	}
	else {
		throw new EnvironmentError("Missing .env");
	}
});

/** 
 * @param {{ require(key: string, type: "string" | "number" | "boolean"): void, [key: string]: string | number | boolean }} env
 * @returns {Promise<mysql.Connection>} 
 */
const db = (env) => new Promise(resolve => {
	env.require("database_name", "string");
	env.require("database_password", "string");

	// Connect to the MySQL server and create the database if it does not exist
	new Promise(resolve => {
		let rootDatabase = mysql.createConnection({
			user: "root",
			password: env.database_password
		});

		rootDatabase.connect(() => {
			rootDatabase.query(`create database if not exists ${env.database_name}`, () => {
				rootDatabase.end();
				resolve();
			});
		});
	})
	// Connect to the database and create any tables that don't exist
	.then(() => new Promise(resolve => {
		let db = mysql.createConnection({
			user: "root",
			password: env.database_password,
			database: env.database_name
		});
	
		db.connect(() => {
			Promise.all([
				new Promise((resolve, reject) => db.query(`create table if not exists sections (id int not null auto_increment, title varchar(128), primary key(id))`, err => err ? reject(err) : resolve())),
				new Promise((resolve, reject) => db.query(`create table if not exists projects (id int not null auto_increment, section int not null, title varchar(128), url varchar(64), repo varchar(256), primary key(id))`, err => err ? reject(err) : resolve())),
				new Promise((resolve, reject) => db.query(`create table if not exists analytics (hash varchar(256) not null, url varchar(128))`, err => err ? reject(err) : resolve()))
			])
			.then(() => resolve(db));
		});
	}))
	.then(resolve);
});

const serve = (env, db) =>  {
	const app = express();

	app.use("/", (req, res, next) => {
		let domain = req.hostname.split(".")[0];

		if (req.ip !== "::1") {
			db.query(`insert ignore into analytics (hash, url) values (${db.escape(req.ip + "@" + req.hostname + req.path)}, ${db.escape(req.hostname + req.path)})`);
		}

		// Handle serving static files & rendering the home page
		const staticHandler = (dir) => {
			if (req.path === "/") {
				let html = fs.readFileSync(path.join(dir, "index.html")).toString();

				let document = htmlParser.parse(html);
				let sectionsElement = document.querySelector("#sections");

				db.query(`select * from sections`, (_error, sections) => {
					let sectionContent = sections.map(section => new Promise(resolve => {
						let html = `<h2>${section.title}</h2>`;

						db.query(`select * from projects where section = ${db.escape(section.id)}`, (_error, projects) => {
							if (projects.length) {
								html += `<ul class="projects">`;

								for (let project of projects) {
									let title = `<span>${project.title}</span>`;
									let repo = project.repo ? `<a class="github" href="${project.repo}" target="_blank">` : "";
									let url = project.url ? `<a class="link" href="${project.url}"></a>` : "";

									html += `<li><div class="wrapper">${title}${repo}${url}</div></li>`;
								}

								html += `</ul>`;
							}

							resolve(html);
						});
					}));

					Promise.all(sectionContent).then(html => {
						sectionsElement.set_content(html.join("<br/>"));

						res.type("text/html").send(document.innerHTML);
					});
				});
			}
			else {
				express.static(dir)(req, res, next);
			}
		}

		// Serve public directory by default
		if (domain === "jessesolomon" || domain === "localhost") {
			return staticHandler("public");
		}
		// If a subdomain has been specified, attempt to serve it from the apps directory
		else {
			let appPath = path.join("apps", domain);

			if (fs.existsSync(appPath)) {
				return staticHandler(appPath);
			}
			else {
				res.status(404).end();
			}
		}
	});

	// If SSL config exists, start the server as HTTPS
	if ("key" in env && "cert" in env) {
		https.createServer(app).listen(443);

		http.createServer((_req, res) => {
			res.statusCode = 301;
			res.setHeader("Location", "https://jessesolomon.dev");
			res.end();
		})
		.listen(80);
	}
	// Otherwise, run in development mode
	else {
		http.createServer(app).listen(8080);
	}
}

env().then(env => db(env).then(db => serve(env, db)));
