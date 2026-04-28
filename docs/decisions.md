# Architecture Decision Records — Autoscaling

Each ADR captures a design decision made during the Spike Autoscaling
project. Decisions are numbered and include context, rationale, and
consequences.

---

## ADR-016: Karpenter alongside managed node group, not replacing it

**Context:** We need a mechanism that will automatically create more nodes for our cluster in case of spikes. Our EKS cluster currently rely on Managed Node Groups for compute. It provides stability but it lacks the speed and cost-efficiency needed for spiky, containerized workloads. 

**Decision:** We will adopt Karpenter for dynamic workloads, but not remove existing Managed Node Groups. Karpenter offers just-in time node provisioning, which is superior for auto-scaling, but introduces risks regarding node churn, misconfiguration, or API outages. If Karpenter has a bug, existing workloads keep running on managed nodes.

---

## ADR-017: Karpenter IAM via CLI first, codify later

**Context:** We need IAM roles for Karpenter. We can create them via Terraform or CLI. 

**Decision:**  CLI first to get fast feedback and understand each permission. Once working, codify in Terraform. Risk: manual changes aren't tracked in Git until codified — must be done before moving on

---

## ADR-018: NodePool limits as cost safety

**Context:** Karpenter can launch unlimited nodes if pods keep requesting resources. A misconfigured HPA or a fork bomb could spin up hundreds of instances.

**Decision:** Implement NodePool limits. We set cpu: 8 and memory: 32Gi — roughly 4 t3.medium nodes maximum. This caps worst-case spend while leaving enough room for legitimate spikes. Without limits, there's nothing stopping Karpenter from launching hundreds of instances.

---

## ADR-019: KEDA over raw HPA for external metrics

**Context:** We need mechanism that auto creates pods when needed, that is driven by metrics. Native HPA only supports CPU and memory. Scaling on custom metrics like HTTP request rate requires either a custom metrics adapter or KEDA.

**Decision:** KEDA offers superior, event-driven scalability, enables scaling to zero, and is significantly simpler to operate for non-CPU/memory metrics. KEDA is simpler to set up and manage as Keda uses simple YAML custom resources to define scaling triggers. It handles the complexity of connecting to the external system, fetching metrics, and creating the HPA behind the scenes. The alternative will require adapters and complex PromQL queries and maintaining RBAC permissions.

---

## ADR-020: k6 as in-cluster Kubernetes Job

**Context:** We need to test our mechanisms that scale up and down our nodes and pods.

**Decision:** Running k6 as an in-cluster Kubernetes Job provides significant advantages over running tests from a local machine, ensuring higher fidelity, consistency, and scalability for performance metrics.
Running inside the cluster means the test hits the same internal DNS path as real service-to-service traffic. Results are consistent and repeatable, not affected by local network or firewall.

---

## ADR-021: Cross-SG all-traffic rules for VPC CNI pod networking

**Context:** EKS module creates two SGs, nodes land in different ones, VPC CNI routes through node ENIs. For pods and nodes to communicate with each other, they need networking. 

**Decision:** Created Cross-Security Group rules for VPC CNI pod networking. Without cross-SG rules, pods on nodes with the cluster SG could not reach pods on nodes with the node SG. Cross-node curl returned HTTP 000 (connection refused). With Karpenter that creates new nodes it is also important because new nodes need to be able to talk to the existing ones. In production, these would be specific port rules instead of all-traffic, with pod-level isolation handled by Kubernetes NetworkPolicies.