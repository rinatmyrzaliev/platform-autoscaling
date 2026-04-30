# Platform Autoscaling — Spike Autoscaling with Karpenter + KEDA + k6

Pod-level and node-level autoscaling driven by real traffic metrics, proven with load tests.
Connects Project 2 (Prometheus metrics) and Project 3 (Argo Rollouts) into a spike-ready platform.

## What this project does

When a traffic spike hits:

1. KEDA watches Prometheus for HTTP request rate on orders-service
2. When rate exceeds 5 rps per pod, KEDA creates an HPA that scales pods (2 → up to 10)
3. If new pods don't fit on existing nodes, they go Pending
4. Karpenter detects Pending pods, picks the cheapest spot instance that fits, and launches it in ~40 seconds
5. Pods schedule on the new node, traffic is served
6. When traffic drops, KEDA scales pods back down, Karpenter removes empty nodes within 30 seconds

## Architecture

```
k6 load test (in-cluster Job)
    │
    │  50 VUs, ~400 rps
    ▼
ingress-nginx ──────────────────────── Prometheus
    │                                  (scrapes nginx_ingress_controller_requests)
    │  routes to                           │
    ▼                                      │ query: rate of requests
orders-service (Argo Rollout)              │
    │                                      ▼
    │                                  KEDA ScaledObject
    │                                      │
    │                                      │ creates/updates
    │                                      ▼
    │                                  HPA (auto-managed)
    │                                      │
    │                              scales pods 2 → 10
    │                                      │
    │                              if pods Pending...
    │                                      │
    │                                      ▼
    │                                  Karpenter
    │                                      │
    │                              launches spot EC2
    │                              (t3.medium or t3.large)
    │                                      │
    └──────────────────────────────────────┘
                pods schedule, traffic served
```

## Repo structure

```
platform-autoscaling/
├── manifests/
│   ├── karpenter/
│   │   ├── ec2nodeclass.yaml         # AMI, subnets, SG (tag-based discovery)
│   │   ├── nodepool.yaml             # Spot t3.medium/large, cpu:8 mem:32Gi limits
│   │   └── test-inflate.yaml         # Dummy pod to prove Karpenter launches nodes
│   ├── keda/
│   │   └── orders-scaledobject.yaml  # Prometheus trigger, threshold 5 rps
│   └── k6/
│       ├── spike-test.js             # 50 VUs, 3-min spike, SLO thresholds
│       ├── spike-job.yaml            # ConfigMap + Job to run k6 in-cluster
│       └── integration-inflate.yaml  # Padding pods to fill nodes for drill
├── docs/
│   └── decisions.md                  # 6 ADRs (ADR-016 through ADR-021)
└── README.md
```

## Integration drill results

Full chain proven end-to-end:

| Metric | Value |
|--------|-------|
| Requests sent | 72,432 |
| Duration | 3 minutes |
| Throughput | 402 rps |
| Success rate | 99.97% (18 failures during node scaling) |
| p95 latency | 4.51ms |
| Pod scaling | 2 → 4 → 8 → 10 |
| Node scaling | Karpenter launched t3.large in ~40s |
| Scale-down | Pods back to 2, Karpenter node removed |

The 18 failures occurred during the ~40 second window while Karpenter was launching a node and pods were Pending. In production, client-side retries and keeping more capacity headroom would cover this gap.

## Quickstart

**Prerequisites:** platform-foundation cluster running with kube-prometheus-stack, Argo Rollouts, and orders-service deployed.

**1. Install Karpenter (v1.12.0):**
```bash
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version "1.12.0" \
  --namespace karpenter --create-namespace \
  --set "settings.clusterName=platform-sandbox" \
  --set "settings.clusterEndpoint=<your-cluster-endpoint>" \
  --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::<account>:role/KarpenterControllerRole-platform-sandbox" \
  --set "replicas=1" \
  --wait
```

**2. Deploy Karpenter resources:**
```bash
kubectl apply -f manifests/karpenter/ec2nodeclass.yaml
kubectl apply -f manifests/karpenter/nodepool.yaml
```

**3. Install KEDA (v2.19.0):**
```bash
helm upgrade --install keda kedacore/keda \
  --version 2.19.0 \
  --namespace keda --create-namespace \
  --set replicas=1 \
  --wait
```

**4. Deploy ScaledObject:**
```bash
kubectl apply -f manifests/keda/orders-scaledobject.yaml
```

**5. Run the spike test:**
```bash
kubectl apply -f manifests/k6/spike-job.yaml
kubectl logs -f job/k6-spike
```

**6. Watch scaling:**
```bash
# In separate terminals:
kubectl get hpa -n orders -w
kubectl get nodes -L karpenter.sh/nodepool -w
```

## IAM requirements (not in this repo)

Karpenter needs two IAM roles created before installation:

**Controller role** (IRSA): `KarpenterControllerRole-platform-sandbox` — lets the Karpenter pod call EC2 APIs (CreateFleet, RunInstances, TerminateInstances, etc.) and IAM APIs (GetInstanceProfile, ListInstanceProfiles).

**Node role** (instance profile): `KarpenterNodeRole-platform-sandbox` — attached to every EC2 instance Karpenter launches. Needs EKSWorkerNodePolicy, EC2ContainerRegistryReadOnly, EKS_CNI_Policy. Must be added as an EKS access entry (type EC2_LINUX).

These were created via CLI and are documented in the ADRs. Production would codify them in Terraform.

## Overnight scale-down

Karpenter nodes are NOT part of the managed node group. Scaling the ASG to 0 does not remove them. The scale-down script in platform-foundation handles this:

```bash
# Deletes NodePool (Karpenter drains + terminates nodes), then scales ASG to 0
bash platform-foundation/scripts/scale-down.sh

# Scales ASG back up, restores NodePool from manifests
bash platform-foundation/scripts/scale-up.sh
```

## Key decisions

| # | Decision | Reason |
|---|----------|--------|
| ADR-016 | Karpenter alongside managed node group | Safe adoption — if Karpenter breaks, workloads stay on managed nodes |
| ADR-017 | IAM via CLI first, Terraform later | Understand each permission before automating |
| ADR-018 | NodePool limits (cpu:8, mem:32Gi) | Cost safety net — caps worst-case at ~4 nodes |
| ADR-019 | KEDA over raw HPA | Manages HPA behind the scenes, no custom metrics adapter needed |
| ADR-020 | k6 as in-cluster Job | Consistent network path, repeatable, same DNS as real traffic |
| ADR-021 | Cross-SG all-traffic rules | EKS two-SG problem fixed in Terraform; production would use specific ports + NetworkPolicies |

## Dependencies

- **Karpenter** v1.12.0 — just-in-time node provisioning
- **KEDA** v2.19.0 — event-driven pod autoscaling
- **k6** (grafana/k6 image) — load testing
- **kube-prometheus-stack** — Prometheus for KEDA triggers and k6 thresholds
- **ingress-nginx** — request metrics for scaling decisions
- **platform-golden-path** — orders-service deployed as Argo Rollout
- **platform-foundation** — EKS cluster, IAM roles, scale scripts