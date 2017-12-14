const fs = require('fs');
const log = new (require('lognext'))('genemail');
const path = require('path');
const yaml = require('yamljs');

const repoData = require(path.join(__dirname, '../cache/repodata.json'));
const repoContacts = yaml.load(path.join(__dirname, '../../open-source-repo-data/repo-contacts.yml'));

Array.prototype.pushArray = function(arr) {
    this.push.apply(this, arr);
};


let to = [];
let cc = [];

// Build list of emails
repoData.forEach((repo) => {
	if (repo.watchlist.length > 0) {
		if (!repoContacts.mypurecloud[repo.name].maintainers) 
			repoContacts.mypurecloud[repo.name].maintainers = [];
		if (!repoContacts.mypurecloud[repo.name].owners) 
			repoContacts.mypurecloud[repo.name].owners = [];

		if (repoContacts.mypurecloud[repo.name].maintainers.length == 0) {
			if (repoContacts.mypurecloud[repo.name].owners.length == 0) {
				log.warn(`${repo.name} is on the watchlist and does not have owners or maintainers defined!`);
				// TODO: make a list of repos with no contacts and call it out in the email
			} else {
				log.warn(`${repo.name} is on the watchlist and does not have maintainers defined! Addressing owners instead.`);
				to.pushArray(repoContacts.mypurecloud[repo.name].owners);
			}
		} else {
			to.pushArray(repoContacts.mypurecloud[repo.name].maintainers);
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

console.log('TO: ');
console.log(JSON.stringify(emailList,null,2));

fs.writeFileSync(path.join(__dirname, '../cache/email-list.txt'), emailList.join(','));