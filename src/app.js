const _ = require('lodash');
const api = require('github-api-promise');
const dot = require('dot');
const fs = require('fs-extra');
const log = new (require('lognext'))('activity report');
const moment = require('moment-timezone');
const path = require('path');
const Q = require('q');
const request = require('request-promise');
const urljoin = require('url-join');
const yaml = require('js-yaml');

const github = require('./github-helpers');
const DATA_CACHE_PATH = path.join(__dirname, '../cache');
const OUTPUT_PATH = path.join(__dirname, '../output');
const GEN_TIMESTAMP = moment().format('YMMDD-HHmmss');
const REPO_CONTACTS_PATH = path.join(__dirname, '../../open-source-repo-data/data/repo-contacts.yml');
const GITHUB_USERS_PATH = path.join(__dirname, '../../open-source-repo-data/data/github-users.yml');
const sortOrder = {
	LAST_COMMIT: 'last commit',
	PRIMARY_CONTACT: 'primary contact'
};


// Set settings
api.config.token = process.env.GITHUB_TOKEN;
api.config.debug = process.env.GITHUB_DEBUG_API === 'true';
dot.templateSettings.strip = false;

let repoData = [];
let repoDataTimestamp = '';
let activityData = { events: [], userEvents: [] };
let activityDataTimestamp = '';
let repoContacts = fs.existsSync(REPO_CONTACTS_PATH) ? yaml.safeLoad(fs.readFileSync(REPO_CONTACTS_PATH, 'utf8')) : {};
let githubUsers = fs.existsSync(GITHUB_USERS_PATH) ? yaml.safeLoad(fs.readFileSync(GITHUB_USERS_PATH, 'utf8')) : {};

const templateFunctions = {
	getMoment: (str) => { return moment(str); },
	diff: (timestamp) => { return moment.duration(moment().diff(timestamp)); },
	loadPartial: (file) => {
		return fs.readFileSync(path.join(__dirname, 'templates/partials', file), 'utf-8');
	}
};

fs.ensureDirSync(DATA_CACHE_PATH);
fs.removeSync(OUTPUT_PATH);
fs.ensureDirSync(OUTPUT_PATH);



log.profile('data load');
log.info('Loading data...');
loadData()
	.then(() => {
		log.profile('data load');
		log.debug(`Processing ${repoData.length} repos...`);

		// Create data object for template
		let data = {
			repos: repoData,
			activity: activityData,
			generatedTimestamp: moment().tz('US/Eastern').format('LLLL z (\\G\\M\\TZ)'),
			repoDataTimestamp: repoDataTimestamp.tz('US/Eastern').format('LLLL z (\\G\\M\\TZ)'),
			activityDataTimestamp: activityDataTimestamp.tz('US/Eastern').format('LLLL z (\\G\\M\\TZ)')
		};

		// Execute templates
		sortRepoData(sortOrder.LAST_COMMIT);
		data.repos = repoData;
		templateFullService({ source: 'repo-status-report', dest: `s3/${GEN_TIMESTAMP}/repo-status-report` }, data, templateFunctions);
		templateFullService('repo-status-report-email', data, templateFunctions);

		sortRepoData(sortOrder.PRIMARY_CONTACT);
		data.repos = repoData;
		templateFullService({ source: 'repo-watchlist', dest: `s3/${GEN_TIMESTAMP}/repo-watchlist` }, data, templateFunctions);
		templateFullService('repo-watchlist-email', data, templateFunctions);

		templateFullService({ source: 'user-activity-report', dest: `s3/${GEN_TIMESTAMP}/user-activity-report` }, data, templateFunctions);
		templateFullService('user-activity-report-email', data, templateFunctions);

		// Copy S3 dir to latest
		let outSource = `${OUTPUT_PATH}/s3/${GEN_TIMESTAMP}`;
		let outDest = `${OUTPUT_PATH}/s3/latest`;
		log.info(`Copying s3 output: ${outSource} -> ${outDest}`);
		fs.copySync(outSource, outDest);
	})
	.catch((err) => {
		log.error(err);
		process.exitCode = 666;
	});



function loadData() {
	let deferred = Q.defer();

	let cachedRepoDataExists = false;
	let cachedActivityDataExists = false;
	let repoDataPath = path.join(DATA_CACHE_PATH, 'repodata.json');
	let repoDataTimestampPath = path.join(DATA_CACHE_PATH, 'repodata.timestamp');
	let activityDataPath = path.join(DATA_CACHE_PATH, 'activityData.json');
	let activityDataTimestampPath = path.join(DATA_CACHE_PATH, 'activityData.timestamp');
	
	if (fs.existsSync(repoDataPath) && fs.existsSync(repoDataTimestampPath)) {
		repoDataTimestamp = moment(fs.readFileSync(repoDataTimestampPath, 'utf8'));
		let cachedMinutes = moment().diff(repoDataTimestamp, 'minutes');
		log.debug(`Cached repo data is ${cachedMinutes} minutes old`);
		cachedRepoDataExists = cachedMinutes < 30;
		if (!cachedRepoDataExists)
			log.info('Cached repo data exists, but is out of date.');
	}
	
	if (fs.existsSync(activityDataPath) && fs.existsSync(activityDataTimestampPath)) {
		activityDataTimestamp = moment(fs.readFileSync(activityDataTimestampPath, 'utf8'));
		let cachedMinutes = moment().diff(activityDataTimestamp, 'minutes');
		log.debug(`Cached activity data is ${cachedMinutes} minutes old`);
		cachedActivityDataExists = cachedMinutes < 30;
		if (!cachedActivityDataExists)
			log.info('Cached activity data exists, but is out of date.');
	}

	let promises = [];
	
	if (cachedRepoDataExists) {
		log.info('Loading repo data from cache');
		repoData = require(repoDataPath);
	} else {
		log.info('Retrieving repo data via github API. This will take a moment.');
		promises.push(loadRepoData('mypurecloud'));
		promises.push(loadRepoData('purecloudlabs'));
	}

	if (cachedActivityDataExists) {
		log.info('Loading activity data from cache');
		activityData = require(activityDataPath);
	} else {
		log.info('Retrieving activity data via github API. This will take a moment.');
		promises.push(loadActivityData());
	}

	Promise.all(promises)
		.then(() => { 
			postProcessRepoData();
			deferred.resolve(); 
		})
		.catch((err) => {
			log.error(err);
			deferred.reject(err);
		});

	return deferred.promise;
}

function loadRepoData(orgName) {
	let deferred = Q.defer();

	log.profile('repo list');
	github.getOrgRepos(orgName)
		.then((data) => {
			log.profile('repo list');
			let promises = [];

			log.info('Getting PRs...');
			log.profile('repo prs');
			_.forEach(data, (repo) => {
				repoData.push(repo);
				promises.push(loadRepositoryPullRequests(repo));
			});

			return Promise.all(promises);
		})
		.then(() => {
			log.profile('repo prs');
			let promises = [];

			log.info('Getting repo commits...');
			log.profile('repo commits');
			_.forEach(repoData, (repo) => {
				log.debug(`Getting commits for ${repo.full_name}`);
				promises.push(loadRepositoryCommits(repo));
				if (repoContacts[repo.owner.login.toLowerCase()][repo.name].monitoredBranches) {
					repoContacts[repo.owner.login.toLowerCase()][repo.name].monitoredBranches.forEach((branchName) => {
						log.debug(`Getting commits for ${repo.full_name}/${branchName}`);
						promises.push(loadRepositoryCommits(repo), branchName);
					});
				}
			});

			return Promise.all(promises);
		})
		.then(() => {
			log.profile('repo commits');
			let promises = [];

			log.info('Getting repo issues...');
			log.profile('repo issues');
			_.forEach(repoData, (repo) => {
				promises.push(loadRepositoryIssues(repo));
			});

			return Promise.all(promises);
		})
		.then(() => {
			log.profile('repo issues');
			let promises = [];

			log.info('Getting PR comments...');
			log.profile('pr comments');
			for (let i = 0; i < repoData.length; i++) {
				repoData[i].pullRequests.forEach((pullRequest) => {
					promises.push(loadPullRequestComments(pullRequest));
				});
			}

			return Promise.all(promises);
		})
		.then(() => {
			log.profile('repo comments');
			let promises = [];

			log.info('Getting PR commits...');
			log.profile('pr commits');
			for (let i = 0; i < repoData.length; i++) {
				repoData[i].pullRequests.forEach((pullRequest) => {
					promises.push(loadPullRequestCommits(pullRequest));
				});
			}
		})
		.then(() => {
			log.profile('pr commits');
			let promises = [];

			log.info('Checking OSS index opt in...');
			log.profile('ossindex');
			for (let i = 0; i < repoData.length; i++) {
				promises.push(checkOssFile(repoData[i]));
			}

			return Promise.all(promises);
		})
		.then(() => {
			log.profile('ossindex');
			postProcessRepoData();
		})
		.then(() => {
			repoDataTimestamp = moment();
			
			fs.writeFileSync(path.join(DATA_CACHE_PATH, 'repodata.json'), JSON.stringify(repoData,null,2));
			fs.writeFileSync(path.join(DATA_CACHE_PATH, 'repodata.timestamp'), repoDataTimestamp.format());

			log.info(`Repo data written to ${DATA_CACHE_PATH}`);

			deferred.resolve();
		})
		.catch((err) => {
			log.error(err);
			deferred.reject(err);
		});

	return deferred.promise;
}

function postProcessRepoData() {
	log.debug(`Request Count: ${api.getRequestCount()}`);
	log.info('Generating repo meta properties...');
	repoData.forEach((repo) => {
		generateRepositoryMetaProperties(repo);
		checkRepositorySla(repo);
	});
}

function sortRepoData(by = sortOrder.LAST_COMMIT) {
	log.debug(`Sorting repo data by ${by}`);
	switch (by) {
		case sortOrder.LAST_COMMIT: {
			// Sort repo data by last repo commit date, most recent first
			repoData = _.sortBy(repoData, (repo) => { return repo.lastCommitDate; });
			repoData.reverse();
			break;
		}
		case sortOrder.PRIMARY_CONTACT: {
			// Sort repo data by primary contact last name, ascending
			repoData = _.sortBy(repoData, (repo) => { 
				let name = repo.contacts.primary.name.split(' ');
				return name[name.length - 1];
			});
			break;
		}
		default: {
			log.warn(`Unknown sort order: ${by}`);
		}
	}
}

function loadActivityData() {
	let deferred = Q.defer();

	github.getOrganizationEvents('mypurecloud', moment().subtract(1, 'week'))
		.then((data) => {
			activityData.events = data;
			return github.getOrganizationEvents('purecloudlabs', moment().subtract(1, 'week'));
		})
		.then((data) => {
			activityData.events = _.concat(activityData.events, data);
			activityData.userEvents = github.aggregateEventsByUser(activityData.events);

			activityData.topUsers = [];
			activityData.eventNames = [];
			activityData.eventCounts = {};

			// Tally event type counts
			_.forEach(activityData.userEvents, (userData, user) => {
				activityData.topUsers.push({ user: user, eventCount: userData.events.length });

				userData.eventCounts = {};
				userData.events.forEach((event) => {
					if (!userData.eventCounts[event.type]) userData.eventCounts[event.type] = 0;
					if (!activityData.eventCounts[event.type]) activityData.eventCounts[event.type] = 0;
					if (!activityData.eventNames.includes(event.type)) activityData.eventNames.push(event.type);

					userData.eventCounts[event.type]++;
					activityData.eventCounts[event.type]++;
				});
			});

			_.forEach(activityData.userEvents, (userData) => {
				activityData.eventNames.forEach((event) => {
					if (!userData.eventCounts[event]) userData.eventCounts[event] = 0;
				});
			});

			// Sort top users list
			activityData.topUsers = _.sortBy(activityData.topUsers, (user) => { return user.eventCount; });
			activityData.topUsers.reverse();
		})
		.then(() => {
			activityDataTimestamp = moment();

			fs.writeFileSync(path.join(DATA_CACHE_PATH, 'activityData.json'), JSON.stringify(activityData,null,2));
			fs.writeFileSync(path.join(DATA_CACHE_PATH, 'activityData.timestamp'), activityDataTimestamp.format());

			log.info(`Activity data written to ${DATA_CACHE_PATH}`);

			deferred.resolve();
		})
		.catch((err) => {
			log.error(err);
			deferred.reject(err);
		});

	return deferred.promise;
}

function checkOssFile(repo) {
	let deferred = Q.defer();

	let ossFile = repo.html_url + '/blob/master/ossindex.json';
	request.get({ 
		uri: ossFile
	})
		.then(() => {
			repo.isOss = true;
			deferred.resolve();
		})
		.catch((err) => {
			repo.isOss = false;
			if (err.statusCode == 404) {
				deferred.resolve();
			} else {
				log.error(err);
				deferred.resolve();
			}
		});

	return deferred.promise;
}

function generateRepositoryMetaProperties(repo) {
	repo.age = moment.duration(moment().diff(repo.created_at)).humanize();

	// Remove issues that are for a PR
	let standaloneIssues = [];
	repo.issues.forEach((issue) => {
		if (!issue.pull_request)
			standaloneIssues.push(issue);
	});
	repo.issues = standaloneIssues;

	// Find most recent commit
	let latestCommit = _.maxBy(repo.commits, (commit) => {
		return commit.commit.author.date;
	});

	repo.lastCommit = latestCommit;
	repo.lastCommitDate = latestCommit.commit.author.date;
	repo.lastCommitDays = moment().diff(latestCommit.commit.author.date, 'days');
	repo.lastCommitAge = repo.commits.length > 0 ? 
		moment.duration(moment().diff(latestCommit.commit.author.date)).humanize() + ' ago' :
		'no commits';

	// Determine repo status
	if (repo.lastCommitDays < 30) {
		repo.status = 'active';
		repo.statusDisplay = 'Active';
	} else if (repo.lastCommitDays < 180) {
		repo.status = 'idle';
		repo.statusDisplay = 'Idle';
	} else if (repo.lastCommitDays < 365) {
		repo.status = 'stagnant';
		repo.statusDisplay = 'Stagnant';
	} else {
		repo.status = 'inactive';
		repo.statusDisplay = 'Inactive';
	}

	// Set counts
	repo.commitCount = repo.commits.length; // This isn't useful right now since we only get the first page of commits (limit 30)
	repo.pullRequestCount = repo.pullRequests.length;
	repo.issueCount = repo.issues.length;

	// Set extra links
	repo.pullRequestsUrl = urljoin(repo.html_url, 'pulls');
	if (repo.has_issues)
		repo.issuesUrl = urljoin(repo.html_url, 'issues');

	// Set repo contacts
	if (repoContacts[repo.owner.login.toLowerCase()][repo.name]) {
		repo.contacts = { 
			owners: repoContacts[repo.owner.login.toLowerCase()][repo.name].owners ,
			maintainers: []
		};

		// Populate maintaner info
		repoContacts[repo.owner.login.toLowerCase()][repo.name].maintainers.forEach((maintainer) => {
			if (githubUsers[maintainer]) {
				repo.contacts.maintainers.push(githubUsers[maintainer]);
			} else {
				log.warn(`Unable to find contact info for ${maintainer}!`);
				repo.contacts.maintainers.push({name: maintainer, email: maintainer });
			}
		});
	}

	if (repo.contacts.maintainers && repo.contacts.maintainers.length > 0)
		repo.contacts.primary = repo.contacts.maintainers[0];
	else if (repo.contacts.owners && repo.contacts.owners.length > 0)
		repo.contacts.primary = repo.contacts.owners[0];
	else
		repo.contacts.primary = { name: 'Unknown', email: 'DeveloperEvangelists@genesys.com' };
}

function checkRepositorySla(repo) {
	repo.watchlist = [];

	// Check issues
	repo.issues.forEach((issue) => {
		let issueLastActivity = moment().diff(issue.updated_at, 'days');
		let issueAge = moment().diff(issue.created_at, 'days');

		// Default to values of false to indicate SLA not met
		issue.sla = {
			initialResponse: { met: false, age: issueAge },
			activity: { met: false, age: issueLastActivity },
			resolution: { met: false, age: issueAge }
		};
		
		// Age less than 3 days or has updates
		if (issueAge <= 3 || issue.created_at != issue.updated_at) {
			issue.sla.initialResponse.met = true;
		}

		// Activity within last 5 days
		if (issueLastActivity <= 5) {
			issue.sla.activity.met = true;
		}

		// Age less than 4 weeks
		if (issueAge < 28) {
			issue.sla.resolution.met = true;
		}

		// If any checks failed, add to watchlist
		if (issue.sla.initialResponse.met === false || 
				issue.sla.activity.met === false || 
				issue.sla.resolution.met === false) {
			issue.watchlistType = 'issue';
			repo.watchlist.push(issue);
		}
	});

	// Check PRs
	repo.pullRequests.forEach((pr) => {
		let prLastActivity = moment().diff(pr.updated_at, 'days');
		let prAge = moment().diff(pr.created_at, 'days');

		// Default to values of false to indicate SLA not met
		pr.sla = {
			initialResponse: { met: false, age: prAge },
			activity: { met: false, age: prLastActivity },
			resolution: { met: false, age: prAge }
		};
		
		// Age less than 3 days or has updates
		if (prAge <= 3 || pr.created_at != pr.updated_at) {
			pr.sla.initialResponse.met = true;
		}

		// Activity within last 5 days
		if (prLastActivity <= 5) {
			pr.sla.activity.met = true;
		}

		// Age less than 4 weeks
		if (prAge < 28) {
			pr.sla.resolution.met = true;
		}

		// If any checks failed, add to watchlist
		if (pr.sla.initialResponse.met === false || 
				pr.sla.activity.met === false || 
				pr.sla.resolution.met === false) {
			pr.watchlistType = 'pull request';
			repo.watchlist.push(pr);
		}
	});

	// Clear watchlist arrays if empty
	// if (repo.watchlist.issues.length === 0) repo.watchlist.issues = undefined;
	// if (repo.watchlist.pullRequests.length === 0) repo.watchlist.pullRequests = undefined;
}

function loadRepositoryIssues(repo) {
	let deferred = Q.defer();

	api.issues.issues.getRepositoryIssues(repo.owner.login, repo.name)
		.then((data) => {
			repo.issues = data;
			deferred.resolve();
		})
		.catch((err) => {
			log.error(err);
			deferred.reject(err);
		});

	return deferred.promise;
}

function loadRepositoryPullRequests(repo) {
	let deferred = Q.defer();

	api.pullRequests.pullRequests.getPullRequests(repo.owner.login, repo.name)
		.then((data) => {
			repo.pullRequests = data;
			deferred.resolve();
		})
		.catch((err) => {
			log.error(err);
			deferred.reject(err);
		});

	return deferred.promise;
}

function loadRepositoryCommits(repo, branchName) {
	let deferred = Q.defer();

	api.repositories.commits.getCommits(repo.owner.login, repo.name, { sha: branchName })
		.then((data) => {
			if (!repo.commits) 
				repo.commits = data;
			else
				repo.commits = _.concat(repo.commits, data);
			
			deferred.resolve();
		})
		.catch((err) => {
			log.error(err);
			deferred.reject(err);
		});

	return deferred.promise;
}

function loadPullRequestCommits(pullRequest) {
	let deferred = Q.defer();

	api.pullRequests.pullRequests.getPullRequestCommits(
		pullRequest.base.user.login, 
		pullRequest.base.repo.name, 
		pullRequest.number)
		.then((data) => {
			pullRequest.commits = data;
			deferred.resolve();
		})
		.catch((err) => {
			log.error(err);
			deferred.reject(err);
		});

	return deferred.promise;
}

function loadPullRequestComments(pullRequest) {
	let deferred = Q.defer();

	api.pullRequests.comments.getPullRequestComments(
		pullRequest.base.user.login, 
		pullRequest.base.repo.name, 
		pullRequest.number)
		.then((data) => {
			pullRequest.comments = data;
			return api.issues.comments.getIssueComments(
				pullRequest.base.user.login, 
				pullRequest.base.repo.name, 
				pullRequest.number);
		})
		.then((data) => {
			pullRequest.comments = pullRequest.comments.concat(data);
			deferred.resolve();
		})
		.catch((err) => {
			log.error(err);
			deferred.reject(err);
		});

	return deferred.promise;
}

function templateFullService(templateName, data, defs) {
	if (typeof(templateName) !== 'object') {
		templateName = {
			source: templateName,
			dest: templateName
		};
	}

	log.profile(`template: ${templateName.source}`);
	let html =  executeTemplate(getTemplate(templateName.source), data, defs);
	let destPath = path.join(OUTPUT_PATH, `${templateName.dest}.html`);
	fs.ensureDirSync(path.dirname(destPath));
	fs.writeFileSync(destPath, html);
	log.debug('File written to ', destPath);
	log.profile(`template: ${templateName.source}`);
}


function executeTemplate(templateString, data, defs) {
	let template = dot.template(templateString, null, defs);
	return template(data);
}

function getTemplate(name) {
	return fs.readFileSync(path.join(__dirname, `templates/${name}.dot`), 'utf8');
}
