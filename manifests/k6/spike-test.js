import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 },   // ramp up to 50 virtual users
    { duration: '2m',  target: 50 },   // hold at 50 for 2 minutes
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(99)<1000'],  // 99% of requests under 1s
    http_req_failed: ['rate<0.05'],     // less than 5% errors
  },
};

export default function () {
  const res = http.get('http://ingress-nginx-controller.ingress-nginx.svc.cluster.local/', {
    headers: { Host: 'orders.lab.local' },
  });
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  sleep(0.1);  // 100ms pause between requests per VU
}
