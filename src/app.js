const _ = require('lodash');
const api = require('github-api-promise');
const dot = require('dot');
const fs = require('fs-extra');
const log = new (require('lognext'))('activity report');
const moment = require('moment-timezone');
const path = require('path');
const Q = require('q');

const github = require('./github-helpers');
const DATA_CACHE_PATH = path.join(__dirname, '../cache');
const OUTPUT_PATH = path.join(__dirname, '../output');



// Set settings
api.config.token = process.env.GITHUB_TOKEN;
api.config.debug = process.env.GITHUB_DEBUG_API === 'true';
dot.templateSettings.strip = false;

var repos = [];
var repoDataTimestamp = '';

const templateFunctions = {
	getMoment: (str) => { return moment(str); },
	diff: (timestamp) => { return moment.duration(moment().diff(timestamp)); }
};

fs.ensureDirSync(DATA_CACHE_PATH);
fs.ensureDirSync(OUTPUT_PATH);



log.profile('data load');
log.info('Loading data...');
loadData()
	.then(() => {
		log.profile('data load');
		log.debug(`Processing ${repos.length} repos...`);

		// Sort repos
		repos = _.sortBy(repos, (repo) => { return repo.lastCommitDate; });
		repos.reverse();

		// Create data object for template
		var data = {
			repos: repos,
			generatedTimestamp: moment().tz('US/Eastern').format('LLLL z (\\G\\M\\TZ)'),
			dataTimestamp: repoDataTimestamp.tz('US/Eastern').format('LLLL z (\\G\\M\\TZ)')
		};

		templateFullService('repo-status-report', data, templateFunctions);
		templateFullService('repo-status-report-email', data, templateFunctions);
	})
	.catch((err) => {
		log.error(err);
		process.exitCode = 666;
	});



function loadData() {
	var deferred = Q.defer();

	let cachedDataExists = false;
	let repoDataPath = path.join(DATA_CACHE_PATH, 'repodata.json');
	let repoDataTimestampPath = path.join(DATA_CACHE_PATH, 'repodata.timestamp');
	
	if (fs.existsSync(repoDataPath) && fs.existsSync(repoDataTimestampPath)) {
		repoDataTimestamp = moment(fs.readFileSync(repoDataTimestampPath, 'utf8'));
		let cachedMinutes = moment().diff(repoDataTimestamp, 'minutes');
		log.debug(`Cached data is ${cachedMinutes} minutes old`);
		cachedDataExists = cachedMinutes < 30;
		if (!cachedDataExists)
			log.info('Cached data exists, but is out of date.');
	}

	if (cachedDataExists) {
		log.info('Loading repo data from cache');
		repos = require(repoDataPath);
		deferred.resolve();
	} else {
		log.info('Retrieving data from github API. This will take a moment.');
		loadApiData()
			.then(() => { deferred.resolve(); })
			.catch((err) => {
				log.error(err);
				deferred.reject(err);
			});
	}

	return deferred.promise;
}

function loadApiData() {
	let deferred = Q.defer();

	log.profile('repo list');
	github.getOrgRepos('mypurecloud')
		.then((data) => {
			log.profile('repo list');
			let promises = [];

			log.info('Getting PRs...');
			log.profile('repo prs');
			_.forEach(data, (repo) => {
				repos.push(repo);
				promises.push(loadRepositoryPullRequests(repo));
			});

			return Promise.all(promises);
		})
		.then(() => {
			log.profile('repo prs');
			let promises = [];

			log.info('Getting repo commits...');
			log.profile('repo commits');
			_.forEach(repos, (repo) => {
				promises.push(loadRepositoryCommits(repo));
			});

			return Promise.all(promises);
		})
		.then(() => {
			log.profile('repo commits');
			let promises = [];

			log.info('Getting repo issues...');
			log.profile('repo issues');
			_.forEach(repos, (repo) => {
				promises.push(loadRepositoryIssues(repo));
			});

			return Promise.all(promises);
		})
		.then(() => {
			log.profile('repo issues');
			let promises = [];

			log.info('Getting PR comments...');
			log.profile('pr comments');
			for (var i = 0; i < repos.length; i++) {
				repos[i].pullRequests.forEach((pullRequest) => {
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
			for (var i = 0; i < repos.length; i++) {
				repos[i].pullRequests.forEach((pullRequest) => {
					promises.push(loadPullRequestCommits(pullRequest));
				});
			}

			return Promise.all(promises);
		})
		.then(() => {
			log.profile('pr commits');
			log.debug(`Request Count: ${api.getRequestCount()}`);
			log.info('Generating repo meta properties...');
			repos.forEach((repo) => {
				generateRepositoryMetaProperties(repo);
			});
		})
		.then(() => {
			repoDataTimestamp = moment();
			fs.writeFileSync(path.join(DATA_CACHE_PATH, 'repodata.json'), JSON.stringify(repos,null,2));
			fs.writeFileSync(path.join(DATA_CACHE_PATH, 'repodata.timestamp'), repoDataTimestamp.format());
			log.info(`Data written to ${DATA_CACHE_PATH}`);

			deferred.resolve();
		})
		.catch((err) => {
			log.error(err);
			deferred.reject(err);
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
	repo.pullRequestsUrl = path.join(repo.html_url, 'pulls');
	if (repo.has_issues)
		repo.issuesUrl = path.join(repo.html_url, 'issues');
}

function loadRepositoryIssues(repo) {
	var deferred = Q.defer();

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
	var deferred = Q.defer();

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

function loadRepositoryCommits(repo) {
	var deferred = Q.defer();

	api.repositories.commits.getCommits(repo.owner.login, repo.name)
		.then((data) => {
			repo.commits = data;
			deferred.resolve();
		})
		.catch((err) => {
			log.error(err);
			deferred.reject(err);
		});

	return deferred.promise;
}

function loadPullRequestCommits(pullRequest) {
	var deferred = Q.defer();

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
	var deferred = Q.defer();

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
	log.profile(`template: ${templateName}`);
	let html =  executeTemplate(getTemplate(templateName), data, defs);
	fs.writeFileSync(path.join(OUTPUT_PATH, `${templateName}.html`), html);
	log.profile(`template: ${templateName}`);
}


function executeTemplate(templateString, data, defs) {
	var template = dot.template(templateString, null, defs);
	return template(data);
}

function getTemplate(name) {
	return fs.readFileSync(path.join(__dirname, `templates/${name}.dot`), 'utf8');
}
