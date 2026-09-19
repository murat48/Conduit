#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, Env, IntoVal,
};

/// Stand-in for the Soroswap router: same signature, a fixed exchange rate, and the same
/// two behaviours this contract depends on — it authorises `to`, and it refuses to settle
/// below `amount_out_min`.
#[contract]
pub struct MockRouter;

#[contractimpl]
impl MockRouter {
    pub fn __constructor(env: Env, rate: i128) {
        env.storage().instance().set(&symbol_short!("rate"), &rate);
    }

    pub fn set_rate(env: Env, rate: i128) {
        env.storage().instance().set(&symbol_short!("rate"), &rate);
    }

    /// The mock is its own pool, so the transfer the caller has to authorise targets this
    /// address — structurally the same hop the real router makes into a pair contract.
    pub fn router_pair_for(env: Env, _token_a: Address, _token_b: Address) -> Address {
        env.current_contract_address()
    }

    pub fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        _deadline: u64,
    ) -> Vec<i128> {
        to.require_auth();

        let rate: i128 = env.storage().instance().get(&symbol_short!("rate")).unwrap();
        let amount_out = amount_in * rate / PRICE_SCALE;
        if amount_out < amount_out_min {
            panic!("insufficient output amount");
        }

        let pair = env.current_contract_address();
        // Pulled from `to` in a frame `to` does not own — this is the call that only
        // succeeds because the mandate contract authorised it explicitly.
        TokenClient::new(&env, &path.first().unwrap()).transfer(&to, &pair, &amount_in);
        TokenClient::new(&env, &path.last().unwrap()).transfer(&pair, &to, &amount_out);

        vec![&env, amount_in, amount_out]
    }
}

use soroban_sdk::symbol_short;

const DAY: u32 = 17_280;
/// 1 USDC, in stroops.
const ONE: i128 = 10_000_000;

struct Setup {
    env: Env,
    client: MandateContractClient<'static>,
    router: Address,
    owner: Address,
    delegate: Address,
    admin: Address,
    usdc: Address,
    xlm: Address,
    other: Address,
}

/// A rate of 1e8 means one unit of input buys ten of output — an executed price of 0.10.
fn setup(rate: i128) -> Setup {
    let env = Env::default();
    env.ledger().set_sequence_number(1_000_000);

    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let delegate = Address::generate(&env);

    let usdc = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let xlm = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let other = env.register_stellar_asset_contract_v2(admin.clone()).address();

    let router = env.register(MockRouter, (rate,));
    let contract_id = env.register(MandateContract, (admin.clone(), router.clone(), usdc.clone()));

    Setup {
        client: MandateContractClient::new(&env, &contract_id),
        env,
        router,
        owner,
        delegate,
        admin,
        usdc,
        xlm,
        other,
    }
}

impl Setup {
    fn mint(&self, token: &Address, to: &Address, amount: i128) {
        StellarAssetClient::new(&self.env, token).mint(to, &amount);
    }

    fn balance(&self, token: &Address, of: &Address) -> i128 {
        TokenClient::new(&self.env, token).balance(of)
    }

    /// What the owner signs once: an allowance to the *contract*, never to the delegate.
    fn approve(&self, token: &Address, amount: i128) {
        TokenClient::new(&self.env, token).approve(
            &self.owner,
            &self.client.address,
            &amount,
            &(self.env.ledger().sequence() + DAY),
        );
    }

    fn mandate(&self) -> Mandate {
        Mandate {
            delegate: self.delegate.clone(),
            assets: vec![&self.env, self.xlm.clone()],
            cap_per_window: 100 * ONE,
            window_ledgers: DAY,
            buy_below: 0,
            sell_above: 0,
            expiration_ledger: self.env.ledger().sequence() + 30 * DAY,
        }
    }
}

#[test]
fn set_and_read_mandate() {
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    assert!(s.client.get_mandate(&s.owner).is_none());

    let mandate = s.mandate();
    s.client.set_mandate(&s.owner, &mandate);

    let stored = s.client.get_mandate(&s.owner).unwrap();
    assert_eq!(stored.delegate, s.delegate);
    assert_eq!(stored.cap_per_window, 100 * ONE);
    assert_eq!(s.client.spent(&s.owner), 0);
}

#[test]
fn set_mandate_requires_the_owner() {
    let s = setup(100_000_000);
    let mandate = s.mandate();

    // Only the delegate signs. The owner is the one whose consent the contract demands, so
    // this must not be enough to install a mandate in their name.
    s.env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &s.delegate,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &s.client.address,
            fn_name: "set_mandate",
            args: (s.owner.clone(), mandate.clone()).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);

    assert!(s.client.try_set_mandate(&s.owner, &mandate).is_err());
}

#[test]
fn rejects_an_invalid_mandate() {
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    let zero_window = Mandate { window_ledgers: 0, ..s.mandate() };
    assert_eq!(
        s.client.try_set_mandate(&s.owner, &zero_window),
        Err(Ok(Error::InvalidMandate))
    );

    let already_expired = Mandate {
        expiration_ledger: s.env.ledger().sequence() - 1,
        ..s.mandate()
    };
    assert_eq!(
        s.client.try_set_mandate(&s.owner, &already_expired),
        Err(Ok(Error::InvalidMandate))
    );

    let no_assets = Mandate { assets: vec![&s.env], ..s.mandate() };
    assert_eq!(
        s.client.try_set_mandate(&s.owner, &no_assets),
        Err(Ok(Error::InvalidMandate))
    );
}

#[test]
fn buy_leg_moves_funds_without_the_owner_signing_the_swap() {
    let s = setup(100_000_000); // 1 USDC buys 10 XLM
    s.env.mock_all_auths();

    s.mint(&s.usdc, &s.owner, 50 * ONE);
    s.mint(&s.xlm, &s.router, 10_000 * ONE);
    s.approve(&s.usdc, 50 * ONE);
    s.client.set_mandate(&s.owner, &s.mandate());

    let out = s.client.execute(&s.owner, &s.usdc, &s.xlm, &(10 * ONE), &0);

    assert_eq!(out, 100 * ONE);
    assert_eq!(s.balance(&s.usdc, &s.owner), 40 * ONE);
    assert_eq!(s.balance(&s.xlm, &s.owner), 100 * ONE);
    // The contract is a conduit, not a vault: nothing is left behind.
    assert_eq!(s.balance(&s.usdc, &s.client.address), 0);
    assert_eq!(s.balance(&s.xlm, &s.client.address), 0);
    assert_eq!(s.client.spent(&s.owner), 10 * ONE);
}

#[test]
fn execute_requires_the_registered_delegate() {
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    s.mint(&s.usdc, &s.owner, 50 * ONE);
    s.mint(&s.xlm, &s.router, 10_000 * ONE);
    s.approve(&s.usdc, 50 * ONE);
    s.client.set_mandate(&s.owner, &s.mandate());

    // A key that is not the delegate authorises the same call.
    let attacker = Address::generate(&s.env);
    s.env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &s.client.address,
            fn_name: "execute",
            args: (
                s.owner.clone(),
                s.usdc.clone(),
                s.xlm.clone(),
                10 * ONE,
                0i128,
            )
                .into_val(&s.env),
            sub_invokes: &[],
        },
    }]);

    assert!(s
        .client
        .try_execute(&s.owner, &s.usdc, &s.xlm, &(10 * ONE), &0)
        .is_err());
    assert_eq!(s.balance(&s.usdc, &s.owner), 50 * ONE);
}

#[test]
fn cap_limits_spending_inside_a_window_and_resets_after_it() {
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    s.mint(&s.usdc, &s.owner, 500 * ONE);
    s.mint(&s.xlm, &s.router, 100_000 * ONE);
    s.approve(&s.usdc, 500 * ONE);
    s.client.set_mandate(&s.owner, &s.mandate()); // cap 100 USDC per day

    s.client.execute(&s.owner, &s.usdc, &s.xlm, &(60 * ONE), &0);
    s.client.execute(&s.owner, &s.usdc, &s.xlm, &(40 * ONE), &0);
    assert_eq!(s.client.spent(&s.owner), 100 * ONE);

    // The cap is now exhausted, and the refusal happens before any funds move.
    assert_eq!(
        s.client.try_execute(&s.owner, &s.usdc, &s.xlm, &ONE, &0),
        Err(Ok(Error::CapExceeded))
    );
    assert_eq!(s.balance(&s.usdc, &s.owner), 400 * ONE);

    // Next window, fresh allowance.
    s.env.ledger().set_sequence_number(1_000_000 + DAY);
    assert_eq!(s.client.spent(&s.owner), 0);
    s.client.execute(&s.owner, &s.usdc, &s.xlm, &(10 * ONE), &0);
    assert_eq!(s.client.spent(&s.owner), 10 * ONE);
}

#[test]
fn selling_back_to_base_does_not_consume_the_cap() {
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    s.mint(&s.xlm, &s.owner, 100 * ONE);
    s.mint(&s.usdc, &s.router, 10_000 * ONE);
    s.approve(&s.xlm, 100 * ONE);
    s.client.set_mandate(&s.owner, &s.mandate());

    s.client.execute(&s.owner, &s.xlm, &s.usdc, &(100 * ONE), &0);

    assert_eq!(s.balance(&s.xlm, &s.owner), 0);
    assert_eq!(s.balance(&s.usdc, &s.owner), 1_000 * ONE);
    assert_eq!(s.client.spent(&s.owner), 0);
}

#[test]
fn buy_bound_refuses_a_price_above_the_ceiling() {
    // Ceiling of 0.10 USDC per XLM.
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    s.mint(&s.usdc, &s.owner, 100 * ONE);
    s.mint(&s.xlm, &s.router, 10_000 * ONE);
    s.approve(&s.usdc, 100 * ONE);
    s.client
        .set_mandate(&s.owner, &Mandate { buy_below: ONE / 10, ..s.mandate() });

    // Exactly at the ceiling: allowed.
    s.client.execute(&s.owner, &s.usdc, &s.xlm, &(10 * ONE), &0);
    assert_eq!(s.balance(&s.xlm, &s.owner), 100 * ONE);

    // The market moves to 0.20 per XLM. The mandate says no, and the router is what enforces
    // it — the swap cannot settle at the minimum the bound implies.
    MockRouterClient::new(&s.env, &s.router).set_rate(&50_000_000);
    assert!(s
        .client
        .try_execute(&s.owner, &s.usdc, &s.xlm, &(10 * ONE), &0)
        .is_err());
    assert_eq!(s.balance(&s.xlm, &s.owner), 100 * ONE);
}

#[test]
fn sell_bound_refuses_a_price_below_the_floor() {
    // Selling 1 XLM yields 0.10 USDC at this rate.
    let s = setup(1_000_000);
    s.env.mock_all_auths();

    s.mint(&s.xlm, &s.owner, 200 * ONE);
    s.mint(&s.usdc, &s.router, 10_000 * ONE);
    s.approve(&s.xlm, 200 * ONE);

    // Floor of 0.20: the current market is half that.
    s.client
        .set_mandate(&s.owner, &Mandate { sell_above: ONE / 5, ..s.mandate() });
    assert!(s
        .client
        .try_execute(&s.owner, &s.xlm, &s.usdc, &(100 * ONE), &0)
        .is_err());
    assert_eq!(s.balance(&s.xlm, &s.owner), 200 * ONE);

    // The price doubles and the same call goes through.
    MockRouterClient::new(&s.env, &s.router).set_rate(&2_000_000);
    s.client.execute(&s.owner, &s.xlm, &s.usdc, &(100 * ONE), &0);
    assert_eq!(s.balance(&s.usdc, &s.owner), 20 * ONE);
}

#[test]
fn caller_supplied_slippage_floor_still_applies() {
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    s.mint(&s.usdc, &s.owner, 100 * ONE);
    s.mint(&s.xlm, &s.router, 10_000 * ONE);
    s.approve(&s.usdc, 100 * ONE);
    s.client.set_mandate(&s.owner, &s.mandate());

    // 10 USDC yields 100 XLM here; demanding 200 must fail rather than settle short.
    assert!(s
        .client
        .try_execute(&s.owner, &s.usdc, &s.xlm, &(10 * ONE), &(200 * ONE))
        .is_err());
}

#[test]
fn rejects_assets_outside_the_mandate() {
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    s.mint(&s.usdc, &s.owner, 100 * ONE);
    s.mint(&s.other, &s.router, 10_000 * ONE);
    s.approve(&s.usdc, 100 * ONE);
    s.client.set_mandate(&s.owner, &s.mandate()); // allows XLM only

    assert_eq!(
        s.client.try_execute(&s.owner, &s.usdc, &s.other, &(10 * ONE), &0),
        Err(Ok(Error::AssetNotAllowed))
    );
}

#[test]
fn rejects_legs_that_bypass_the_base_asset() {
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    s.client.set_mandate(&s.owner, &s.mandate());

    // XLM → OTHER never touches USDC, so neither the cap nor the price bounds would bind.
    assert_eq!(
        s.client.try_execute(&s.owner, &s.xlm, &s.other, &(10 * ONE), &0),
        Err(Ok(Error::NotBaseLeg))
    );
    assert_eq!(
        s.client.try_execute(&s.owner, &s.usdc, &s.usdc, &(10 * ONE), &0),
        Err(Ok(Error::SameAsset))
    );
    assert_eq!(
        s.client.try_execute(&s.owner, &s.usdc, &s.xlm, &0, &0),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn expired_mandate_stops_executing() {
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    s.mint(&s.usdc, &s.owner, 100 * ONE);
    s.mint(&s.xlm, &s.router, 10_000 * ONE);
    s.approve(&s.usdc, 100 * ONE);
    s.client.set_mandate(&s.owner, &s.mandate()); // expires in 30 days

    s.env.ledger().set_sequence_number(1_000_000 + 31 * DAY);
    assert_eq!(
        s.client.try_execute(&s.owner, &s.usdc, &s.xlm, &(10 * ONE), &0),
        Err(Ok(Error::Expired))
    );
}

#[test]
fn revoking_stops_the_delegate_immediately() {
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    s.mint(&s.usdc, &s.owner, 100 * ONE);
    s.mint(&s.xlm, &s.router, 10_000 * ONE);
    // The allowance is deliberately left in place: revoking the mandate alone has to be
    // enough, because the allowance was granted to the contract and not to the delegate.
    s.approve(&s.usdc, 100 * ONE);
    s.client.set_mandate(&s.owner, &s.mandate());
    s.client.execute(&s.owner, &s.usdc, &s.xlm, &(10 * ONE), &0);

    s.client.revoke(&s.owner);

    assert!(s.client.get_mandate(&s.owner).is_none());
    assert_eq!(
        s.client.try_execute(&s.owner, &s.usdc, &s.xlm, &(10 * ONE), &0),
        Err(Ok(Error::NoMandate))
    );
}

#[test]
fn execute_without_a_mandate_is_refused() {
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    assert_eq!(
        s.client.try_execute(&s.owner, &s.usdc, &s.xlm, &(10 * ONE), &0),
        Err(Ok(Error::NoMandate))
    );
}

#[test]
fn only_the_admin_can_repoint_the_router() {
    let s = setup(100_000_000);
    let new_router = Address::generate(&s.env);

    s.env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &s.owner,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &s.client.address,
            fn_name: "set_router",
            args: (new_router.clone(),).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.client.try_set_router(&new_router).is_err());

    s.env.mock_all_auths();
    s.client.set_router(&new_router);
    assert_eq!(s.client.router(), new_router);
    assert_eq!(s.client.base(), s.usdc);
    assert_eq!(s.admin, s.admin);
}

#[test]
fn mandates_are_per_owner() {
    let s = setup(100_000_000);
    s.env.mock_all_auths();

    let other_owner = Address::generate(&s.env);
    s.client.set_mandate(&s.owner, &s.mandate());

    assert!(s.client.get_mandate(&other_owner).is_none());
    assert_eq!(
        s.client
            .try_execute(&other_owner, &s.usdc, &s.xlm, &(10 * ONE), &0),
        Err(Ok(Error::NoMandate))
    );
}
