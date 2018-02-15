const fs = require('fs');
const log = new (require('lognext'))('genemail');
const path = require('path');
const yaml = require('yamljs');

const repoData = require(path.join(__dirname, '../cache/repodata.json'));
const repoContacts = yaml.load(path.join(__dirname, '../../open-source-repo-data/data/repo-contacts.yml'));
const githubUsers = yaml.load(path.join(__dirname, '../../open-source-repo-data/data/github-users.yml'));

Array.prototype.pushArray = function(arr) {
    this.push.apply(this, arr);
};


let to = [];
let cc = [];

// Build list of emails from watchlist
repoData.forEach((repo) => {
	if (repo.watchlist.length > 0) {
		if (!repoContacts[repo.owner.login.toLowerCase()][repo.name]) {
			// TODO: make a list of repos with no config and call it out in the email
			log.error(`No configuration for ${repo.name}!`);
			return;
		}

		if (!repoContacts[repo.owner.login.toLowerCase()][repo.name].maintainers) 
			repoContacts[repo.owner.login.toLowerCase()][repo.name].maintainers = [];
		if (!repoContacts[repo.owner.login.toLowerCase()][repo.name].owners) 
			repoContacts[repo.owner.login.toLowerCase()][repo.name].owners = [];

		if (repoContacts[repo.owner.login.toLowerCase()][repo.name].maintainers.length == 0) {
			if (repoContacts[repo.owner.login.toLowerCase()][repo.name].owners.length == 0) {
				log.error(`${repo.name} is on the watchlist and does not have owners or maintainers defined!`);
				// TODO: make a list of repos with no contacts and call it out in the email
			} else {
				log.warn(`${repo.name} is on the watchlist and does not have maintainers defined! Addressing owners instead.`);
				to.pushArray(repoContacts[repo.owner.login.toLowerCase()][repo.name].owners);
			}
		} else {
			let maintainerContacts = [];
			repoContacts[repo.owner.login.toLowerCase()][repo.name].maintainers.forEach((maintainer) => {
				if (githubUsers[maintainer]) {
					maintainerContacts.push(githubUsers[maintainer]);
				} else {
					log.error(`Failed to find contact information for maintainer ${maintainer}`);
				}
			});
			to.pushArray(maintainerContacts);
		}
	}
});

// Add opt-ins
cc.pushArray(repoContacts['mypurecloud-opt-in']);

// Sanatize lists
let emailList = [];

to.forEach((member) => {
	if (emailList.indexOf(member.email) < 0) 
		emailList.push(member.email);
});

cc.forEach((member) => {
	if (emailList.indexOf(member.email) < 0) 
		emailList.push(`cc:${member.email}`);
});

console.log('Watchlist emails: ');
console.log(JSON.stringify(emailList,null,2));

fs.writeFileSync(path.join(__dirname, '../cache/watchlist-emails.txt'), emailList.join(','));

// Opt in only list
let optInEmails = [];
repoContacts['mypurecloud-opt-in'].forEach((member) => {
	if (optInEmails.indexOf(member.email) < 0) 
		optInEmails.push(member.email);
});

console.log('Opt in emails: ');
console.log(JSON.stringify(optInEmails,null,2));

fs.writeFileSync(path.join(__dirname, '../cache/mypurecloud-opt-in.txt'), optInEmails.join(','));
