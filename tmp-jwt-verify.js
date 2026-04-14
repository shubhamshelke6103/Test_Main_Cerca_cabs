const jwt = require('jsonwebtoken');
const secret = '@#@!#@dasd4234jkdh3874#$@#$#$@#$#$dkjashdlk$#442343%#$%f34234T$vtwefcEC$%';
const payload = { id: '0123456789abcdef01234567' };
const token = jwt.sign(payload, secret, { algorithm: 'HS256', noTimestamp: true });
console.log('token:', token);
console.log('decoded:', jwt.verify(token, secret));
