package com.jeidorf.tokenledger.mobile.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Test

class V2NavigationModelsTest {

    @Test
    fun visibleMobileDestinationsHidesRoutingWhenDisabled() {
        assertEquals(
            listOf(MobileDestination.Usage, MobileDestination.Quota, MobileDestination.Me),
            visibleMobileDestinations(showRouting = false)
        )
    }

    @Test
    fun visibleMobileDestinationsShowsAllEntriesWhenEnabled() {
        assertEquals(
            listOf(
                MobileDestination.Usage,
                MobileDestination.Routing,
                MobileDestination.Quota,
                MobileDestination.Me
            ),
            visibleMobileDestinations(showRouting = true)
        )
        assertEquals(MobileDestination.entries, visibleMobileDestinations(showRouting = true))
    }
}
