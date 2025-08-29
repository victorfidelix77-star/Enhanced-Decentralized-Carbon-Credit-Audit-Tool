;; CarbonCreditRegistry.clar
;; Core contract for registering and issuing carbon credits as NFTs
;; Ensures unique issuance with validator approvals, immutable metadata, and fraud prevention hooks

;; Constants
(define-constant ERR-UNAUTHORIZED (err u100))
(define-constant ERR-ALREADY-REGISTERED (err u101))
(define-constant ERR-INVALID-AMOUNT (err u102))
(define-constant ERR-INVALID-METADATA (err u103))
(define-constant ERR-INSUFFICIENT-APPROVALS (err u104))
(define-constant ERR-ALREADY-APPROVED (err u105))
(define-constant ERR-NOT-PENDING (err u106))
(define-constant ERR-CREDIT-NOT-FOUND (err u107))
(define-constant ERR-INVALID-STATUS (err u108))
(define-constant ERR-PAUSED (err u109))
(define-constant ERR-INVALID-HASH (err u110))
(define-constant ERR-MAX-APPROVALS-REACHED (err u111))
(define-constant ERR-INVALID-VALIDATOR (err u112))
(define-constant MAX-METADATA-LEN u500)
(define-constant MAX-APPROVALS u10)
(define-constant DEFAULT-REQUIRED-APPROVALS u3)
(define-constant CONTRACT-OWNER tx-sender)

;; Data Variables
(define-data-var contract-paused bool false)
(define-data-var total-credits uint u0)
(define-data-var proposal-counter uint u0)
(define-data-var admin principal CONTRACT-OWNER)

;; Data Maps
(define-map validators principal { active: bool, added-at: uint })
(define-map pending-proposals
  { proposal-id: uint }
  {
    issuer: principal,
    amount: uint,
    metadata: (string-utf8 500),
    hash: (buff 32),
    approvals: (list 10 principal),
    required-approvals: uint,
    timestamp: uint,
    status: (string-ascii 20)  ;; "pending", "approved", "rejected"
  }
)

(define-map credits
  { credit-id: uint }
  {
    owner: principal,
    amount: uint,
    metadata: (string-utf8 500),
    hash: (buff 32),
    issuance-timestamp: uint,
    status: (string-ascii 20)  ;; "active", "retired"
  }
)

(define-map credit-ownership
  { hash: (buff 32) }
  { credit-id: uint }
)

;; Public Functions
(define-public (propose-credit-issuance (amount uint) (metadata (string-utf8 500)) (hash (buff 32)))
  (let
    (
      (proposal-id (+ (var-get proposal-counter) u1))
      (is-valid-hash (not (is-eq hash 0x0000000000000000000000000000000000000000000000000000000000000000)))
    )
    (if (var-get contract-paused)
      (err ERR-PAUSED)
      (begin
        (asserts! (> amount u0) ERR-INVALID-AMOUNT)
        (asserts! (<= (len metadata) MAX-METADATA-LEN) ERR-INVALID-METADATA)
        (asserts! is-valid-hash ERR-INVALID-HASH)
        (asserts! (is-none (map-get? credit-ownership { hash: hash })) ERR-ALREADY-REGISTERED)
        (map-set pending-proposals
          { proposal-id: proposal-id }
          {
            issuer: tx-sender,
            amount: amount,
            metadata: metadata,
            hash: hash,
            approvals: (list ),
            required-approvals: DEFAULT-REQUIRED-APPROVALS,
            timestamp: block-height,
            status: "pending"
          }
        )
        (var-set proposal-counter proposal-id)
        (ok proposal-id)
      )
    )
  )
)

(define-public (approve-proposal (proposal-id uint) (validator principal))
  (let
    (
      (proposal (unwrap! (map-get? pending-proposals { proposal-id: proposal-id }) ERR-NOT-PENDING))
      (validator-info (unwrap! (map-get? validators validator) ERR-INVALID-VALIDATOR))
      (current-approvals (get approvals proposal))
    )
    (if (var-get contract-paused)
      (err ERR-PAUSED)
      (begin
        (asserts! (get active validator-info) ERR-INVALID-VALIDATOR)
        (asserts! (is-eq (get status proposal) "pending") ERR-NOT-PENDING)
        (asserts! (not (is-some (index-of current-approvals validator))) ERR-ALREADY-APPROVED)
        (asserts! (< (len current-approvals) MAX-APPROVALS) ERR-MAX-APPROVALS-REACHED)
        (let
          (
            (new-approvals (unwrap! (as-max-len? (append current-approvals validator) MAX-APPROVALS) ERR-MAX-APPROVALS-REACHED))
            (updated-proposal (merge proposal { approvals: new-approvals }))
          )
          (map-set pending-proposals { proposal-id: proposal-id } updated-proposal)
          (if (>= (len new-approvals) (get required-approvals proposal))
            (try! (issue-credit proposal-id))
            (ok true)
          )
        )
      )
    )
  )
)

(define-public (reject-proposal (proposal-id uint) (validator principal))
  (let
    (
      (proposal (unwrap! (map-get? pending-proposals { proposal-id: proposal-id }) ERR-NOT-PENDING))
      (validator-info (unwrap! (map-get? validators validator) ERR-INVALID-VALIDATOR))
    )
    (if (var-get contract-paused)
      (err ERR-PAUSED)
      (begin
        (asserts! (get active validator-info) ERR-INVALID-VALIDATOR)
        (asserts! (is-eq (get status proposal) "pending") ERR-NOT-PENDING)
        (map-set pending-proposals
          { proposal-id: proposal-id }
          (merge proposal { status: "rejected" })
        )
        (ok true)
      )
    )
  )
)

(define-public (transfer-credit (credit-id uint) (new-owner principal))
  (let
    (
      (credit (unwrap! (map-get? credits { credit-id: credit-id }) ERR-CREDIT-NOT-FOUND))
    )
    (if (var-get contract-paused)
      (err ERR-PAUSED)
      (begin
        (asserts! (is-eq (get owner credit) tx-sender) ERR-UNAUTHORIZED)
        (asserts! (is-eq (get status credit) "active") ERR-INVALID-STATUS)
        (map-set credits
          { credit-id: credit-id }
          (merge credit { owner: new-owner })
        )
        (ok true)
      )
    )
  )
)

(define-public (retire-credit (credit-id uint))
  (let
    (
      (credit (unwrap! (map-get? credits { credit-id: credit-id }) ERR-CREDIT-NOT-FOUND))
    )
    (if (var-get contract-paused)
      (err ERR-PAUSED)
      (begin
        (asserts! (is-eq (get owner credit) tx-sender) ERR-UNAUTHORIZED)
        (asserts! (is-eq (get status credit) "active") ERR-INVALID-STATUS)
        (map-set credits
          { credit-id: credit-id }
          (merge credit { status: "retired" })
        )
        (ok true)
      )
    )
  )
)

(define-public (set-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-UNAUTHORIZED)
    (var-set admin new-admin)
    (ok true)
  )
)

(define-public (pause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-UNAUTHORIZED)
    (var-set contract-paused true)
    (ok true)
  )
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-UNAUTHORIZED)
    (var-set contract-paused false)
    (ok true)
  )
)

(define-public (add-validator (validator principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-UNAUTHORIZED)
    (asserts! (is-none (map-get? validators validator)) ERR-ALREADY-REGISTERED)
    (map-set validators
      validator
      { active: true, added-at: block-height }
    )
    (ok true)
  )
)

(define-public (remove-validator (validator principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-UNAUTHORIZED)
    (asserts! (is-some (map-get? validators validator)) ERR-INVALID-VALIDATOR)
    (map-set validators
      validator
      { active: false, added-at: (unwrap! (get added-at (map-get? validators validator)) ERR-INVALID-VALIDATOR) }
    )
    (ok true)
  )
)

;; Private Functions
(define-private (issue-credit (proposal-id uint))
  (let
    (
      (proposal (unwrap! (map-get? pending-proposals { proposal-id: proposal-id }) ERR-NOT-PENDING))
      (credit-id (+ (var-get total-credits) u1))
    )
    (asserts! (>= (len (get approvals proposal)) (get required-approvals proposal)) ERR-INSUFFICIENT-APPROVALS)
    (asserts! (is-eq (get status proposal) "pending") ERR-NOT-PENDING)
    (map-set credits
      { credit-id: credit-id }
      {
        owner: (get issuer proposal),
        amount: (get amount proposal),
        metadata: (get metadata proposal),
        hash: (get hash proposal),
        issuance-timestamp: block-height,
        status: "active"
      }
    )
    (map-set credit-ownership
      { hash: (get hash proposal) }
      { credit-id: credit-id }
    )
    (map-set pending-proposals
      { proposal-id: proposal-id }
      (merge proposal { status: "approved" })
    )
    (var-set total-credits credit-id)
    (ok credit-id)
  )
)

;; Read-Only Functions
(define-read-only (get-credit-details (credit-id uint))
  (map-get? credits { credit-id: credit-id })
)

(define-read-only (get-proposal-details (proposal-id uint))
  (map-get? pending-proposals { proposal-id: proposal-id })
)

(define-read-only (get-credit-by-hash (hash (buff 32)))
  (let
    (
      (credit-id (unwrap! (map-get? credit-ownership { hash: hash }) ERR-CREDIT-NOT-FOUND))
    )
    (map-get? credits { credit-id: credit-id })
  )
)

(define-read-only (is-validator (validator principal))
  (match (map-get? validators validator)
    validator-info (get active validator-info)
    false
  )
)

(define-read-only (get-total-credits)
  (var-get total-credits)
)

(define-read-only (get-admin)
  (var-get admin)
)

(define-read-only (is-paused)
  (var-get contract-paused)
)