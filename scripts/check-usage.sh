#!/bin/bash
# Usage tracking query script
# Usage: ./scripts/check-usage.sh <command> [args]

set -e

WORKER_URL="${WORKER_URL:-https://code-reviewer.workers.dev}"

usage() {
    cat << EOF
Usage: $0 <command> [args]

Commands:
  pr <owner> <repo> <pr_number>           Get latest usage for a PR
  pr-sha <owner> <repo> <pr_number> <sha> Get usage for specific commit
  list <owner> <repo> [limit]             List all reviews (default: 50)
  stats <owner> <repo>                    Get repository statistics
  monthly-cost <owner> <repo>             Show total monthly cost

Examples:
  $0 pr myorg myrepo 123
  $0 stats myorg myrepo
  $0 monthly-cost myorg myrepo

Environment:
  WORKER_URL - Your worker URL (default: https://code-reviewer.workers.dev)
EOF
    exit 1
}

if [ $# -lt 1 ]; then
    usage
fi

COMMAND=$1
shift

case "$COMMAND" in
    pr)
        if [ $# -lt 3 ]; then
            echo "Error: pr command requires owner, repo, and pr_number"
            usage
        fi
        OWNER=$1
        REPO=$2
        PR_NUM=$3
        
        echo "📊 Fetching usage for PR #$PR_NUM in $OWNER/$REPO..."
        curl -s "$WORKER_URL/usage/$OWNER/$REPO/pr/$PR_NUM" | jq '.'
        ;;
    
    pr-sha)
        if [ $# -lt 4 ]; then
            echo "Error: pr-sha command requires owner, repo, pr_number, and sha"
            usage
        fi
        OWNER=$1
        REPO=$2
        PR_NUM=$3
        SHA=$4
        
        echo "📊 Fetching usage for PR #$PR_NUM (commit $SHA) in $OWNER/$REPO..."
        curl -s "$WORKER_URL/usage/$OWNER/$REPO/pr/$PR_NUM?sha=$SHA" | jq '.'
        ;;
    
    list)
        if [ $# -lt 2 ]; then
            echo "Error: list command requires owner and repo"
            usage
        fi
        OWNER=$1
        REPO=$2
        LIMIT=${3:-50}
        
        echo "📋 Listing up to $LIMIT reviews for $OWNER/$REPO..."
        curl -s "$WORKER_URL/usage/$OWNER/$REPO?limit=$LIMIT" | jq '.'
        ;;
    
    stats)
        if [ $# -lt 2 ]; then
            echo "Error: stats command requires owner and repo"
            usage
        fi
        OWNER=$1
        REPO=$2
        
        echo "📈 Fetching statistics for $OWNER/$REPO..."
        curl -s "$WORKER_URL/usage/$OWNER/$REPO/stats" | jq '.'
        ;;
    
    monthly-cost)
        if [ $# -lt 2 ]; then
            echo "Error: monthly-cost command requires owner and repo"
            usage
        fi
        OWNER=$1
        REPO=$2
        
        echo "💰 Calculating monthly cost for $OWNER/$REPO..."
        STATS=$(curl -s "$WORKER_URL/usage/$OWNER/$REPO/stats")
        
        TOTAL_COST=$(echo "$STATS" | jq -r '.totalCost')
        TOTAL_REVIEWS=$(echo "$STATS" | jq -r '.totalReviews')
        AVG_COST=$(echo "$STATS" | jq -r '.avgCostPerReview')
        
        echo ""
        echo "Total Reviews: $TOTAL_REVIEWS"
        echo "Total Cost: \$$TOTAL_COST"
        echo "Average Cost per Review: \$$AVG_COST"
        echo ""
        echo "By Provider:"
        echo "$STATS" | jq -r '.byProvider | to_entries[] | "  \(.key): \(.value.reviews) reviews, $\(.value.cost)"'
        ;;
    
    *)
        echo "Error: Unknown command '$COMMAND'"
        usage
        ;;
esac
