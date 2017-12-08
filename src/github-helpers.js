const api = require('github-api-promise');
const log = new (require('lognext'))('github');
const moment = require('moment-timezone');
const Q = require('q');



module.exports = {
	// Recursively gets events for the given range
	getUserOrganizationEvents: function (username, org, rangeStart, rangeEnd, page = 1, events = [], deferred = Q.defer()) {
		let self = this;
		log.debug(`Getting events page ${page}`);
		api.activity.events.getUserOrganizationEvents(username, org, { page: page })
			.then(function(res) {
				events = events.concat(res);

				rangeStart = moment.isMoment(rangeStart) ? rangeStart : moment().subtract(1, 'year');
				rangeEnd = moment.isMoment(rangeEnd) ? rangeEnd : moment().add(1, 'year');

				let lastEventTimestamp = moment(events[events.length - 1].created_at);

				if (page < 10 && lastEventTimestamp > rangeStart) {
					self.getUserOrganizationEvents(username, org, rangeStart, rangeEnd, page + 1, events, deferred);
				} else {
					var finalEvents = [];
					// Prune results
					for (let i=0; i<events.length; i++) {
						let eventTimestamp = moment(events[i].created_at);
						if (rangeStart <= eventTimestamp && eventTimestamp <= rangeEnd)
							finalEvents.push(events[i]);
					}

					log.debug(`${events.length} events pruned to ${finalEvents.length}`);

					deferred.resolve(finalEvents);
				}
			})
			.catch(function(err) {
				log.error(err);
				deferred.reject(err);
			});

		return deferred.promise;
	},

	// Recursively gets events for the given range
	getOrganizationEvents: function (org, rangeStart, rangeEnd, page = 1, events = [], deferred = Q.defer()) {
		let self = this;
		log.debug(`Getting events page ${page}`);
		api.activity.events.getOrganizationEvents(org, { page: page })
			.then(function(res) {
				events = events.concat(res);

				rangeStart = moment.isMoment(rangeStart) ? rangeStart : moment().subtract(1, 'year');
				rangeEnd = moment.isMoment(rangeEnd) ? rangeEnd : moment().add(1, 'year');

				let lastEventTimestamp = moment(events[events.length - 1].created_at);

				if (page < 10 && lastEventTimestamp > rangeStart) {
					self.getOrganizationEvents(org, rangeStart, rangeEnd, page + 1, events, deferred);
				} else {
					var finalEvents = [];
					// Prune results
					for (let i=0; i<events.length; i++) {
						let eventTimestamp = moment(events[i].created_at);
						if (rangeStart <= eventTimestamp && eventTimestamp <= rangeEnd)
							finalEvents.push(events[i]);
					}

					log.debug(`${events.length} events pruned to ${finalEvents.length}`);

					deferred.resolve(finalEvents);
				}
			})
			.catch(function(err) {
				log.error(err);
				deferred.reject(err);
			});

		return deferred.promise;
	},

	// Creates an object with keys=username, values=array of events
	aggregateEventsByUser: function(events) {
		let users = {};
		events.forEach((event) => {
			if (!users[event.actor.display_login]) 
				users[event.actor.display_login] = { events: [] };
			users[event.actor.display_login].events.push(event);
			users[event.actor.display_login].url = `https://github.com/${event.actor.display_login}`;;
			users[event.actor.display_login].avatar_url = event.actor.avatar_url;
		});
		return users;
	},

	getOrgRepos: function(org, page = 1, repos = [], deferred = Q.defer()) {
		let self = this;
		log.debug(`Getting repos page ${page}`);
		api.repositories.repositories.getOrgRepos(org, { page: page })
			.then((res) => {
				if (res.length === 0) {
					deferred.resolve(repos);
					return;
				}

				repos = repos.concat(res);
				self.getOrgRepos(org, page + 1, repos, deferred);
			})
			.catch(function(err) {
				log.error(err);
				deferred.reject(err);
			});

		return deferred.promise;
	}
};
